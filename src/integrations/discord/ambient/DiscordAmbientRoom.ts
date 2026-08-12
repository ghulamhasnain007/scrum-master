import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import {
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from '@discordjs/voice';
import { ChannelType, type Client, type VoiceBasedChannel } from 'discord.js';
import { discord48kStereoToGemini16kMono, gemini24kMonoToDiscord48kStereo, pcm16PeakLevel } from '../audioResample.js';
import { GeminiAmbientService, type AmbientFunctionCall, type AmbientFunctionDeclaration } from '../../../services/GeminiAmbientService.js';
import { buildAmbientSystemPrompt } from './systemPrompt.js';

/** How long with zero speaking activity from anyone before the ambient
 *  session (Gemini connection + subscriptions) closes. Voice presence
 *  itself is untouched — see AmbientPresenceManager. Matches the 90s
 *  default from AMBIENT_BOT_ARCHITECTURE_PLAN.md §3.1. */
const IDLE_TIMEOUT_MS = 90_000;

/** Same watchdog window DiscordMeetingRoom uses to confirm a subscription
 *  is actually delivering audio after a claim is made. */
const SPEAKING_WATCHDOG_MS = 2_500;

/** Same echo-prevention safety margin as DiscordMeetingRoom §4.6 — held
 *  open a beat after both Gemini and the audio player confirm playback is
 *  actually finished, not a blind timer guessing how long a response takes. */
const MIC_REOPEN_SAFETY_MS = 150;

function log(guildId: string, channelId: string, ...args: unknown[]): void {
  console.log(`[DiscordAmbientRoom:${guildId}/${channelId}]`, ...args);
}

interface ActiveSubscription {
  discordUserId: string;
  opusStream: AudioReceiveStream;
  decoder: prism.opus.Decoder;
  generation: number;
}

/** Injected by setupAmbient.ts — Phase C leaves this undefined (no task
 *  actions registered yet). Phase D passes AMBIENT_TASK_TOOLS + a handler
 *  backed by TaskStore. Keeping this as an injected extension point means
 *  this file doesn't change between those two phases — only what's wired
 *  in from outside does. */
export interface AmbientFunctionHandling {
  declarations: AmbientFunctionDeclaration[];
  handle: (call: AmbientFunctionCall, ctx: { speakerName: string; channelId: string }) => Promise<Record<string, unknown>>;
}

/**
 * Owns ONE persistently-joined ambient voice channel.
 *
 * Combines every phase built so far:
 *   Phase A — persistent presence + speaking-trigger detection
 *   Phase B — per-speaker subscriptions, claim model for overlapping speakers
 *   Phase C — the actual Gemini AUDIO-mode session (prompt-gated silence,
 *             no TTS — see systemPrompt.ts and AMBIENT_BOT_ARCHITECTURE_PLAN.md §5)
 *   Phase D — task actions, ONLY if a functionHandling implementation is
 *             injected via the constructor (see AmbientFunctionHandling above)
 *
 * Claim resolution is driven by Gemini's real turnComplete signal, not a
 * local silence timer — turnComplete fires whether or not the model
 * actually produced audio, which is exactly what lets "decided to stay
 * silent" correctly free up the floor for the next speaker.
 *
 * KNOWN SIMPLIFICATION: if a second person starts talking while someone
 * else holds the claim, their audio is not buffered — only logged as
 * waiting. A fuller implementation (pre-buffering candidate speakers) is
 * deferred until real usage shows this is worth the added complexity.
 */
export class DiscordAmbientRoom {
  private knownHumanIds = new Set<string>();
  private displayNameCache = new Map<string, string>();
  private stopped = false;

  private currentSub: ActiveSubscription | null = null;
  private currentClaimDisplayName = '';
  private subscriptionGeneration = 0;
  private lastPacketAt = 0;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionOpen = false;
  private lastIdleClosedAt: number | null = null;
  private lastSpeakingAt: number | null = null;

  private gemini: GeminiAmbientService | null = null;
  private player: AudioPlayer | null = null;
  private outputStream: PassThrough | null = null;
  private aiSpeaking = false;
  private geminiDoneSendingAudio = false;
  /** Reset per claim, set true the moment any audio chunk actually comes
   *  back from Gemini. Distinguishes "correctly stayed silent" from "sent
   *  audio to Gemini but something's actually broken" in the logs — the
   *  exact ambiguity that made a real silent-by-design turn look
   *  indistinguishable from a bug. */
  private turnProducedAudio = false;

  private turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: 0 };

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly connection: VoiceConnection,
    private readonly functionHandling?: AmbientFunctionHandling
  ) {}

  async attach(): Promise<void> {
    await this.refreshKnownHumans();

    this.player = createAudioPlayer();
    this.player.on('error', (err) => log(this.guildId, this.channelId, 'audio player error:', err.message));
    // Same idle-reattach fix as DiscordMeetingRoom §4.5: once the player
    // drains a resource it detaches from it, so a fresh PassThrough is
    // needed for the next response rather than reusing an abandoned one.
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.outputStream = null;
      this.maybeReopenMic();
    });
    this.connection.subscribe(this.player);

    this.connection.receiver.speaking.on('start', (discordUserId) => {
      if (this.stopped) return;
      this.lastSpeakingAt = Date.now();
      const known = this.knownHumanIds.has(discordUserId);
      if (!known) void this.refreshKnownHumans();

      this.bumpIdleTimer();

      if (!this.currentSub) {
        void this.claim(discordUserId);
      } else if (this.currentSub.discordUserId !== discordUserId) {
        log(
          this.guildId,
          this.channelId,
          `${discordUserId} wants to speak but ${this.currentSub.discordUserId} currently holds the floor — will pick this up once the current turn resolves`
        );
      }
    });

    this.connection.on('stateChange', (oldState, newState) => {
      log(this.guildId, this.channelId, `voice connection state: ${oldState.status} -> ${newState.status}`);
    });

    log(this.guildId, this.channelId, 'ambient room attached — listening for speaking activity');
  }

  // ── Claim + Gemini session lifecycle ────────────────────────────────────

  private async claim(discordUserId: string): Promise<void> {
    const displayName = await this.resolveDisplayName(discordUserId);
    this.currentClaimDisplayName = displayName;

    if (!this.gemini) {
      log(this.guildId, this.channelId, 'opening Gemini session (first activity since idle)');
      await this.openGeminiSession();
    }

    log(this.guildId, this.channelId, `${displayName} (${discordUserId}) claims the floor`);
    this.turnProducedAudio = false;
    this.gemini?.sendSystemHint(`[SYSTEM: The current speaker is now ${displayName}.]`);
    this.subscribeToSpeaker(discordUserId);
  }

  private async openGeminiSession(): Promise<void> {
    const taskActionsEnabled = !!this.functionHandling;
    const botName = this.client.user?.username ?? 'Assistant';
    const systemPrompt = buildAmbientSystemPrompt({ taskActionsEnabled, botName });

    this.gemini = new GeminiAmbientService(
      systemPrompt,
      this.functionHandling?.declarations ?? [],
      {
        onAudioChunk: (chunk) => {
          this.aiSpeaking = true;
          this.geminiDoneSendingAudio = false;
          this.turnProducedAudio = true;
          this.playAudioChunk(chunk);
        },
        onAudioDone: () => {
          this.geminiDoneSendingAudio = true;
          if (this.player?.state.status === AudioPlayerStatus.Idle) this.maybeReopenMic();
          // Gemini's real turnComplete signal is what actually resolves the
          // claim — this is why Phase B's local silence timer was removed
          // entirely rather than kept as a fallback.
          this.resolveClaim();
        },
        onTranscript: (role, text) => log(this.guildId, this.channelId, `transcript[${role}]:`, text),
        onFunctionCall: (call) => void this.handleFunctionCall(call),
        onError: (msg) => log(this.guildId, this.channelId, 'Gemini error:', msg),
      }
    );

    await this.gemini.connect();
    this.sessionOpen = true;
    log(this.guildId, this.channelId, 'Gemini session ready');
  }

  private async handleFunctionCall(call: AmbientFunctionCall): Promise<void> {
    if (!this.functionHandling || !this.gemini) return;
    log(this.guildId, this.channelId, `function call: ${call.name}`, call.args);
    try {
      const result = await this.functionHandling.handle(call, { speakerName: this.currentClaimDisplayName, channelId: this.channelId });
      this.gemini.respondToFunctionCall(call.id, call.name, result);
    } catch (err) {
      log(this.guildId, this.channelId, `function call ${call.name} failed:`, err instanceof Error ? err.message : err);
      this.gemini.respondToFunctionCall(call.id, call.name, {
        success: false,
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  /** Ends the current claim — teardown the subscription, log the turn.
   *  The Gemini session itself stays open (idle timeout handles that
   *  separately) so the next claim on the same session doesn't pay a
   *  reconnect cost. */
  private resolveClaim(): void {
    if (!this.currentSub) return;
    log(
      this.guildId,
      this.channelId,
      `turn resolved for ${this.currentSub.discordUserId}: ${this.turnStats.received} received, ` +
        `${this.turnStats.sentToGemini} sent to Gemini, ${this.turnStats.droppedByGate} dropped by echo-gate, ` +
        `${this.turnStats.resubscribes} resubscribe(s) — ` +
        `${this.turnProducedAudio ? 'Gemini responded' : 'Gemini stayed silent (prompt-gated — not addressed, or genuinely no speech recognized)'}`
    );
    this.teardownSubscription();
  }

  // ── Audio in: subscription for whoever currently holds the claim ───────

  private subscribeToSpeaker(discordUserId: string): void {
    this.teardownSubscription();

    this.turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: this.turnStats.resubscribes };
    this.lastPacketAt = Date.now();

    // Same EndBehaviorType.Manual + internal-cache-delete fix as
    // DiscordMeetingRoom (architecture doc §4.2) — required for the
    // self-heal below to ever get a genuinely fresh stream.
    const opusStream = this.connection.receiver.subscribe(discordUserId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const generation = ++this.subscriptionGeneration;
    this.currentSub = { discordUserId, opusStream, decoder, generation };

    const onDied = (reason: string) => {
      if (this.stopped) return;
      if (this.currentSub?.generation !== generation) return;
      log(this.guildId, this.channelId, `subscription for ${discordUserId} ended unexpectedly (${reason}) — resubscribing`);
      this.turnStats.resubscribes++;
      this.currentSub = null;
      this.subscribeToSpeaker(discordUserId);
    };
    opusStream.on('error', (err) => onDied(`opus stream error: ${err.message}`));
    opusStream.on('close', () => onDied('opus stream closed'));
    decoder.on('error', (err) => onDied(`decoder error: ${err.message}`));

    opusStream.pipe(decoder);

    decoder.on('data', (pcm48kStereo: Buffer) => {
      this.turnStats.received++;
      this.lastPacketAt = Date.now();
      this.bumpIdleTimer();

      const pcm16kMono = discord48kStereoToGemini16kMono(pcm48kStereo);
      pcm16PeakLevel(pcm16kMono); // available for a future heartbeat log, same as DiscordMeetingRoom's diagnostic

      // Same echo-prevention principle as DiscordMeetingRoom §4.6 — don't
      // forward mic audio while the bot itself is talking.
      if (this.aiSpeaking) {
        this.turnStats.droppedByGate++;
        return;
      }

      this.turnStats.sentToGemini++;
      this.gemini?.sendAudio(pcm16kMono.toString('base64'));
    });

    const checkFromTime = Date.now();
    setTimeout(() => {
      if (this.stopped) return;
      if (this.currentSub?.generation !== generation) return;
      if (this.lastPacketAt < checkFromTime) {
        log(this.guildId, this.channelId, `watchdog: no audio ${SPEAKING_WATCHDOG_MS}ms after claim for ${discordUserId} — resubscribing`);
        this.turnStats.resubscribes++;
        this.currentSub = null;
        this.subscribeToSpeaker(discordUserId);
      }
    }, SPEAKING_WATCHDOG_MS);
  }

  private teardownSubscription(): void {
    if (!this.currentSub) return;
    const { discordUserId, opusStream, decoder } = this.currentSub;

    try { decoder.destroy(); } catch { /* already closed */ }
    try { opusStream.destroy(); } catch { /* already closed */ }
    this.connection.receiver.subscriptions.delete(discordUserId); // same non-obvious fix as DiscordMeetingRoom §4.2

    this.currentSub = null;
  }

  // ── Audio out: Gemini's speech → Discord voice playback ─────────────────

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

  /** Same two-signal gating as DiscordMeetingRoom §4.6 — only reopen the
   *  mic once BOTH Gemini says it's done sending audio AND the player has
   *  actually finished draining what it was given. */
  private maybeReopenMic(): void {
    if (!this.geminiDoneSendingAudio || !this.aiSpeaking) return;
    setTimeout(() => {
      if (!this.geminiDoneSendingAudio) return; // a new response may have started generating in the meantime
      this.aiSpeaking = false;
    }, MIC_REOPEN_SAFETY_MS);
  }

  // ── Idle session teardown ───────────────────────────────────────────────

  private bumpIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeIdleSession(), IDLE_TIMEOUT_MS);
  }

  /** Closes the Gemini session and any lingering subscription after a
   *  stretch of silence. The voice connection is never touched here — see
   *  AmbientPresenceManager. Guards against closing mid-turn per
   *  architecture plan §8. */
  private closeIdleSession(): void {
    if (this.currentSub) {
      log(this.guildId, this.channelId, 'idle timer fired while a claim was active — deferring close');
      this.bumpIdleTimer();
      return;
    }
    if (!this.sessionOpen) return;

    this.sessionOpen = false;
    this.lastIdleClosedAt = Date.now();
    this.gemini?.disconnect();
    this.gemini = null;
    log(this.guildId, this.channelId, `ambient session idle-closed after ${IDLE_TIMEOUT_MS / 1000}s of silence — voice connection remains open`);
  }

  // ── Roster / diagnostics ────────────────────────────────────────────────

  private async refreshKnownHumans(): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = await guild.channels.fetch(this.channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) return;
      const voiceChannel = channel as VoiceBasedChannel;
      this.knownHumanIds = new Set(
        [...voiceChannel.members.values()].filter((m) => !m.user.bot).map((m) => m.id)
      );
    } catch (err) {
      log(this.guildId, this.channelId, 'failed to refresh known humans:', err instanceof Error ? err.message : err);
    }
  }

  private async resolveDisplayName(discordUserId: string): Promise<string> {
    const cached = this.displayNameCache.get(discordUserId);
    if (cached) return cached;
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const member = await guild.members.fetch(discordUserId);
      this.displayNameCache.set(discordUserId, member.displayName);
      return member.displayName;
    } catch {
      return discordUserId; // fall back to the raw id rather than failing the claim
    }
  }

  getDiagnostics() {
    return {
      guildId: this.guildId,
      channelId: this.channelId,
      connectionStatus: this.connection.state.status,
      knownHumanCount: this.knownHumanIds.size,
      lastSpeakingAt: this.lastSpeakingAt,
      sessionOpen: this.sessionOpen,
      currentClaimHolder: this.currentSub?.discordUserId ?? null,
      lastIdleClosedAt: this.lastIdleClosedAt,
      taskActionsEnabled: !!this.functionHandling,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.teardownSubscription();
    try { this.gemini?.disconnect(); } catch { /* already closing */ }
    this.gemini = null;
    try { this.player?.stop(); } catch { /* already stopped */ }
    this.player = null;
    try { this.outputStream?.end(); } catch { /* already closed */ }
    this.outputStream = null;
    log(this.guildId, this.channelId, 'ambient room detached');
  }
}
