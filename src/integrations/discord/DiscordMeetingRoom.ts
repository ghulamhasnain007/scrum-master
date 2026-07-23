import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import { ChannelType, type Client } from 'discord.js';
import { MeetingStateService } from '../../services/MeetingStateService.js';
import { GeminiLiveService } from '../../services/GeminiLiveService.js';
import { discord48kStereoToGemini16kMono, gemini24kMonoToDiscord48kStereo } from './audioResample.js';

const TIMER_TICK_MS = 5_000;

/**
 * Runs one Daily Scrum inside a Discord voice channel. Deliberately reuses
 * MeetingStateService and GeminiLiveService completely unchanged from the
 * hosted web-meeting path (MeetingSession.ts) — same turn-taking logic,
 * same Gemini system prompt, same standup data model. Only the transport
 * differs: audio in/out comes from Discord's voice gateway instead of a
 * browser mic/speaker over WebSocket.
 *
 * Turn-taking here works the same way as the web version: only the current
 * speaker's audio is decoded and forwarded to Gemini. Everyone else's
 * speaking events are ignored at the source (see handleSpeakingStart),
 * which also means we skip the CPU cost of decoding audio nobody needs.
 */
export class DiscordMeetingRoom {
  private stateService = new MeetingStateService();
  private gemini: GeminiLiveService | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private outputStream: PassThrough | null = null;

  private discordToParticipant = new Map<string, string>();
  private activeSubscriptions = new Set<string>();

  private timerId: ReturnType<typeof setInterval> | null = null;
  private timeLimitFired = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string
  ) {}

  getState() {
    return this.stateService.getState();
  }

  async start(durationMs?: number): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const channel = await guild.channels.fetch(this.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error('That channel is not a voice channel');
    }

    const humanMembers = [...channel.members.values()].filter((m) => !m.user.bot);
    if (humanMembers.length === 0) {
      throw new Error('No one is currently in that voice channel — join it first, then start the meeting');
    }

    this.stateService.reset(durationMs);
    for (const member of humanMembers) {
      const participant = this.stateService.addParticipant(member.displayName);
      this.discordToParticipant.set(member.id, participant.id);
    }

    this.connection = joinVoiceChannel({
      guildId: this.guildId,
      channelId: this.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);

    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on('start', (discordUserId) => this.handleSpeakingStart(discordUserId));

    this.stateService.startMeeting();

    this.gemini = new GeminiLiveService(this.stateService, {
      onAudioChunk: (chunk) => this.playAudioChunk(chunk),
      onAudioDone: () => {},
      // Transcript/standup data are already written into stateService by
      // GeminiLiveService itself — callers just read getState() for them.
      onTranscript: () => {},
      onStandupUpdate: () => {},
      onPhaseChange: (phase) => {
        if (phase === 'completed') setTimeout(() => void this.stop(), 6_000);
      },
      onReadyForNextParticipant: () => this.handleTurnAdvance(),
      onError: (message) => console.error('[DiscordMeetingRoom] Gemini error:', message),
    });

    await this.gemini.connect();

    const first = this.stateService.getCurrentSpeaker();
    const roster = this.stateService
      .getState()
      .turnOrder.map((id) => this.stateService.getParticipant(id)?.name)
      .filter(Boolean)
      .join(', ');

    this.gemini.sendSystemHint(
      `[SYSTEM: The daily standup meeting has just started in a Discord voice channel with the following team member(s), in speaking order: ${roster}. ` +
        `Greet the team warmly and briefly introduce yourself as the AI Scrum Master, then address ${first?.name ?? 'the first team member'} by name and begin their update. ` +
        `Call update_standup_data with the initial state for ${first?.name ?? 'them'} (greeting phase, 10% complete, readyForNextParticipant=false).]`
    );

    this.startTimerTick();
  }

  async stop(): Promise<void> {
    this.clearTimer();
    this.gemini?.disconnect();
    this.gemini = null;
    this.player?.stop();
    this.player = null;
    this.outputStream?.end();
    this.outputStream = null;
    this.connection?.destroy();
    this.connection = null;
    this.stateService.endMeeting();
  }

  // ── Audio in: only decode/forward the current speaker's voice ──────────────

  private handleSpeakingStart(discordUserId: string): void {
    const participantId = this.discordToParticipant.get(discordUserId);
    if (!participantId || participantId !== this.stateService.currentSpeakerId) return; // not their turn
    if (!this.connection || this.activeSubscriptions.has(discordUserId)) return;

    const opusStream = this.connection.receiver.subscribe(discordUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.activeSubscriptions.add(discordUserId);

    opusStream.pipe(decoder);

    decoder.on('data', (pcm48kStereo: Buffer) => {
      // Re-check on every packet: the turn may have advanced mid-stream.
      if (participantId !== this.stateService.currentSpeakerId) return;
      const pcm16kMono = discord48kStereoToGemini16kMono(pcm48kStereo);
      this.gemini?.sendAudio(pcm16kMono.toString('base64'));
    });

    const cleanup = () => this.activeSubscriptions.delete(discordUserId);
    decoder.once('end', cleanup);
    decoder.once('error', cleanup);
  }

  // ── Audio out: Gemini's speech → Discord voice playback ─────────────────────

  private playAudioChunk(base64Pcm24kMono: string): void {
    if (!this.player) return;
    const pcm48kStereo = gemini24kMonoToDiscord48kStereo(Buffer.from(base64Pcm24kMono, 'base64'));

    if (!this.outputStream) {
      this.outputStream = new PassThrough();
      const resource = createAudioResource(this.outputStream, { inputType: StreamType.Raw });
      this.player.play(resource);
    }
    this.outputStream.write(pcm48kStereo);
  }

  // ── Turn handoff — mirrors MeetingSession.handleTurnAdvance for parity ─────

  private handleTurnAdvance(): void {
    const finishing = this.stateService.getCurrentSpeaker();
    const next = this.stateService.advanceTurn();

    if (next) {
      this.gemini?.sendSystemHint(
        `[SYSTEM: ${finishing?.name ?? 'That team member'}'s update is complete. Thank them briefly, then address ${next.name} by name and ask what they completed yesterday. ` +
          `Call update_standup_data for ${next.name} with phase="yesterday" and completionPercentage around 10-20, readyForNextParticipant=false.]`
      );
    } else {
      this.gemini?.sendSystemHint(
        `[SYSTEM: Every team member has now given their update. Give one brief overall team summary — mention any blockers across the team — then professionally close the meeting. ` +
          `Call update_standup_data one final time with phase="completed" and completionPercentage=100, readyForNextParticipant=false.]`
      );
    }
  }

  private startTimerTick(): void {
    this.timerId = setInterval(() => {
      const state = this.stateService.getState();
      if (!state.isActive) {
        this.clearTimer();
        return;
      }
      if (this.stateService.isTimeExpired() && !this.timeLimitFired) {
        this.timeLimitFired = true;
        this.gemini?.sendSystemHint(
          '[SYSTEM: The meeting time limit has been reached. Stop asking new questions. If team members remain, move through them as quickly as possible; otherwise summarize everything collected so far, explicitly mention any missing information, then professionally close the meeting. Call update_standup_data with phase="summary" first.]'
        );
      }
    }, TIMER_TICK_MS);
  }

  private clearTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}
