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
  AudioPlayerStatus,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from '@discordjs/voice';
import { ChannelType, type Client } from 'discord.js';
import { MeetingStateService } from '../../services/MeetingStateService.js';
import { GeminiLiveService } from '../../services/GeminiLiveService.js';
import { discord48kStereoToGemini16kMono, gemini24kMonoToDiscord48kStereo, pcm16PeakLevel } from './audioResample.js';

const TIMER_TICK_MS = 5_000;

function log(guildId: string, ...args: unknown[]): void {
  console.log(`[DiscordMeetingRoom:${guildId}]`, ...args);
}

/**
 * Runs one Daily Scrum inside a Discord voice channel. Deliberately reuses
 * MeetingStateService and GeminiLiveService completely unchanged from the
 * hosted web-meeting path (MeetingSession.ts) — same turn-taking logic,
 * same Gemini system prompt, same standup data model. Only the transport
 * differs: audio in/out comes from Discord's voice gateway instead of a
 * browser mic/speaker over WebSocket.
 *
 * Audio-in design: ONE continuous subscription per speaker turn, opened the
 * moment it becomes their turn and torn down only when the turn ends —
 * NOT re-opened per speaking burst. An earlier version subscribed with
 * `EndBehaviorType.AfterSilence(800ms)` and re-subscribed on each Discord
 * "speaking start" event; any natural pause in speech (i.e. every sentence)
 * closed that subscription, and re-opening it reliably on the next burst
 * turned out to be exactly the bug that made the bot go silent after the
 * first exchange. Using `EndBehaviorType.Manual` and holding the stream
 * open for the whole turn mirrors how the browser-mic path already works
 * (continuous capture, Gemini's own VAD decides where speech starts/ends)
 * and removes that whole class of bug.
 */
export class DiscordMeetingRoom {
  private stateService = new MeetingStateService();
  private gemini: GeminiLiveService | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private outputStream: PassThrough | null = null;

  private discordToParticipant = new Map<string, string>();
  private participantToDiscord = new Map<string, string>();

  private currentSub: { discordUserId: string; opusStream: AudioReceiveStream; decoder: prism.opus.Decoder } | null = null;
  private audioPacketsReceived = 0;
  private audioChunksSentToGemini = 0;
  private audioPacketsSent = 0; // chunks sent to Discord (Gemini's spoken responses)
  private peakLevelSinceHeartbeat = 0;
  /** Accumulates decoded 16kHz mono chunks before sending to Gemini in
   *  ~100ms batches (matching the browser mic path's cadence) instead of
   *  firing a WebSocket message per 20ms Opus packet. */
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private static readonly SEND_BATCH_BYTES = 3_200; // 100ms @ 16kHz mono PCM16 (1600 samples * 2 bytes)

  private timerId: ReturnType<typeof setInterval> | null = null;
  private timeLimitFired = false;
  private stopped = false;

  /** True while the bot is actively speaking (plus a short grace period
   *  after) — see subscribeToCurrentSpeaker() for why mic forwarding is
   *  paused during this window. */
  private aiSpeaking = false;
  private aiSpeakingGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string,
    /** Called once, at the end of stop() — lets the owning manager remove
     *  this room from its active-meetings registry regardless of *why* the
     *  meeting ended (explicit stop, natural completion, or an error). */
    private readonly onEnded?: () => void
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
      this.participantToDiscord.set(participant.id, member.id);
    }
    log(this.guildId, 'roster:', humanMembers.map((m) => `${m.displayName} (${m.id})`).join(', '));

    this.connection = joinVoiceChannel({
      guildId: this.guildId,
      channelId: this.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // required — a self-deafened bot receives no audio at all
      selfMute: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    log(this.guildId, 'voice connection ready');

    this.connection.on('stateChange', (oldState, newState) => {
      log(this.guildId, `voice connection state: ${oldState.status} -> ${newState.status}`);
    });

    // Purely diagnostic — confirms the voice gateway is delivering speaking
    // events at all, independent of whose turn it is or our subscription logic.
    this.connection.receiver.speaking.on('start', (discordUserId) => {
      const name = this.discordToParticipant.has(discordUserId) ? 'known participant' : 'unknown/bot';
      log(this.guildId, `speaking start: ${discordUserId} (${name})`);
    });

    this.player = createAudioPlayer();
    this.player.on('error', (err) => log(this.guildId, 'audio player error:', err.message));
    this.player.on('stateChange', (oldState, newState) => {
      log(this.guildId, `audio player state: ${oldState.status} -> ${newState.status}`);
    });
    // Once the player fully drains a resource it goes Idle and detaches from
    // it — writing more PCM into that same PassThrough afterward goes
    // nowhere, because nothing is reading it anymore. This was the actual
    // "no audio after the greeting" bug: the greeting played because it was
    // the first-ever resource; every response after that was written into an
    // abandoned stream. Clearing outputStream here makes the next
    // playAudioChunk() call create + play() a fresh resource instead.
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.outputStream = null;
    });
    this.connection.subscribe(this.player);

    this.stateService.startMeeting();
    this.subscribeToCurrentSpeaker();

    this.gemini = new GeminiLiveService(this.stateService, {
      onAudioChunk: (chunk) => {
        // Mark speaking immediately, and cancel any pending "resume
        // listening" timer from a previous utterance that hasn't fired yet.
        this.aiSpeaking = true;
        if (this.aiSpeakingGraceTimer) {
          clearTimeout(this.aiSpeakingGraceTimer);
          this.aiSpeakingGraceTimer = null;
        }
        // Drop anything buffered right at this instant too, so a partial
        // ~100ms mic chunk captured a moment ago never gets flushed later.
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.playAudioChunk(chunk);
      },
      onAudioDone: () => {
        // Small grace period after Gemini signals it's done generating
        // audio, covering Discord's own playback buffer drain — otherwise
        // the tail end of the bot's own voice can still leak into the mic
        // right as it finishes talking and trigger a spurious interruption.
        this.aiSpeakingGraceTimer = setTimeout(() => {
          this.aiSpeaking = false;
          this.aiSpeakingGraceTimer = null;
        }, 400);
      },
      // Transcript/standup data are already written into stateService by
      // GeminiLiveService itself — callers just read getState() for them.
      onTranscript: (role, content) => log(this.guildId, `transcript[${role}]:`, content),
      onStandupUpdate: () => {},
      onPhaseChange: (phase) => {
        log(this.guildId, 'phase ->', phase);
        if (phase === 'completed') setTimeout(() => void this.stop(), 6_000);
      },
      onReadyForNextParticipant: () => this.handleTurnAdvance(),
      onError: (message) => log(this.guildId, 'Gemini error:', message),
    });

    await this.gemini.connect();
    log(this.guildId, 'Gemini Live connected');

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

    // Diagnostic heartbeat. Read this as three independent signals:
    //  - "decoded" stuck at 0 while someone's talking -> audio isn't
    //    reaching this process from Discord at all (self-deafen/mute,
    //    permissions, or Server Members Intent).
    //  - "decoded" climbing but "peak level" near 0 -> audio IS arriving
    //    but is silence/near-silence once decoded+resampled — a codec or
    //    resampling bug, not a Discord-side problem.
    //  - "peak level" healthy but "to Gemini" not growing, or growing but
    //    Gemini never replies -> the problem is downstream, in what Gemini
    //    does with audio it's actually receiving.
    setInterval(() => {
      if (this.stopped) return;
      log(
        this.guildId,
        `audio — decoded: ${this.audioPacketsReceived}, peak level: ${this.peakLevelSinceHeartbeat.toFixed(3)}, ` +
          `to Gemini: ${this.audioChunksSentToGemini}, to Discord: ${this.audioPacketsSent}`
      );
      this.peakLevelSinceHeartbeat = 0;
    }, 15_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return; // idempotent — natural completion + explicit stop can race
    this.stopped = true;

    this.clearTimer();
    if (this.aiSpeakingGraceTimer) {
      clearTimeout(this.aiSpeakingGraceTimer);
      this.aiSpeakingGraceTimer = null;
    }
    this.teardownSubscription();

    // Each step is isolated: a failure in one (e.g. the voice connection
    // already dropped) must not prevent the others from running, and must
    // never prevent onEnded() from firing.
    try { this.gemini?.disconnect(); } catch (err) { log(this.guildId, 'gemini disconnect failed:', err); }
    this.gemini = null;

    try { this.player?.stop(); } catch (err) { log(this.guildId, 'player stop failed:', err); }
    this.player = null;

    try { this.outputStream?.end(); } catch { /* stream may already be closed */ }
    this.outputStream = null;

    try { this.connection?.destroy(); } catch (err) { log(this.guildId, 'voice connection destroy failed:', err); }
    this.connection = null;

    try { this.stateService.endMeeting(); } catch (err) { log(this.guildId, 'endMeeting failed:', err); }

    log(this.guildId, 'stopped');
    this.onEnded?.();
  }

  // ── Audio in: one continuous subscription for whoever's turn it is ─────────

  private subscribeToCurrentSpeaker(): void {
    this.teardownSubscription();

    if (!this.connection) return;
    const speaker = this.stateService.getCurrentSpeaker();
    if (!speaker) return;

    const discordUserId = this.participantToDiscord.get(speaker.id);
    if (!discordUserId) {
      log(this.guildId, `no Discord user mapped for current speaker "${speaker.name}" — can't listen to them`);
      return;
    }

    log(this.guildId, `listening to ${speaker.name} (${discordUserId})`);

    // Manual end behavior: the stream stays open for this person's ENTIRE
    // turn regardless of pauses — Discord simply sends no packets during
    // silence, it does not close the stream. Only WE close it, when the
    // turn changes or the meeting ends. This is the key fix — see the class
    // doc comment above for why AfterSilence-based re-subscription broke.
    const opusStream = this.connection.receiver.subscribe(discordUserId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.currentSub = { discordUserId, opusStream, decoder };

    opusStream.on('error', (err) => log(this.guildId, `opus stream error for ${discordUserId}:`, err.message));
    decoder.on('error', (err) => log(this.guildId, `opus decoder error for ${discordUserId}:`, err.message));

    opusStream.pipe(decoder);

    this.pendingAudio = [];
    this.pendingAudioBytes = 0;

    decoder.on('data', (pcm48kStereo: Buffer) => {
      this.audioPacketsReceived++;
      const pcm16kMono = discord48kStereoToGemini16kMono(pcm48kStereo);

      const level = pcm16PeakLevel(pcm16kMono);
      if (level > this.peakLevelSinceHeartbeat) this.peakLevelSinceHeartbeat = level;

      // Discord voice gives us raw PCM with no acoustic echo cancellation
      // (unlike the browser mic path's getUserMedia echoCancellation) — if
      // we keep forwarding audio while the bot itself is talking, anything
      // its voice bleeds into the mic (speaker leakage, room echo) can make
      // Gemini think it's being interrupted and cut its own response off
      // mid-sentence. Simplest reliable fix: don't forward mic audio while
      // the bot is speaking (plus a short grace period after — see
      // aiSpeakingGraceTimer). Still counted above for heartbeat visibility.
      if (this.aiSpeaking) return;

      this.pendingAudio.push(pcm16kMono);
      this.pendingAudioBytes += pcm16kMono.length;

      if (this.pendingAudioBytes >= DiscordMeetingRoom.SEND_BATCH_BYTES) {
        const combined = Buffer.concat(this.pendingAudio);
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.audioChunksSentToGemini++;
        this.gemini?.sendAudio(combined.toString('base64'));
      }
    });
  }

  private teardownSubscription(): void {
    if (!this.currentSub) return;

    if (this.pendingAudioBytes > 0) {
      const combined = Buffer.concat(this.pendingAudio);
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      this.audioChunksSentToGemini++;
      this.gemini?.sendAudio(combined.toString('base64'));
    }

    const { opusStream, decoder } = this.currentSub;
    try { decoder.destroy(); } catch { /* already closed */ }
    try { opusStream.destroy(); } catch { /* already closed */ }
    this.currentSub = null;
  }

  // ── Audio out: Gemini's speech → Discord voice playback ─────────────────────

  private playAudioChunk(base64Pcm24kMono: string): void {
    if (!this.player) return;
    this.audioPacketsSent++;
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
      this.subscribeToCurrentSpeaker();
      this.gemini?.sendSystemHint(
        `[SYSTEM: ${finishing?.name ?? 'That team member'}'s update is complete. Thank them briefly, then address ${next.name} by name and ask what they completed yesterday. ` +
          `Call update_standup_data for ${next.name} with phase="yesterday" and completionPercentage around 10-20, readyForNextParticipant=false.]`
      );
    } else {
      this.teardownSubscription(); // no more individual turns — final summary needs no mic input
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
