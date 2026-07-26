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
import { discord48kStereoToGemini16kMono, gemini24kMonoToDiscord48kStereo, pcm16PeakLevel, applyGainPcm16 } from './audioResample.js';
import type { AudioDiagnostics } from '../../types/index.js';

const TIMER_TICK_MS = 5_000;

/** How long to wait, after Discord has actually finished playing the bot's
 *  full response AND Gemini has signaled it's done sending audio, before
 *  reopening the mic. Small — just covers the last bit of network/jitter
 *  flight time for the final frame — because it's now anchored to a real
 *  "done" signal instead of being a blind guess covering both "did Discord
 *  finish playing" and "did Gemini finish talking" at once. */
const MIC_REOPEN_SAFETY_MS = 50;

/** After a participant's "speaking start" fires, how long to wait for an
 *  actual decoded audio packet before concluding the subscription is dead
 *  (e.g. Discord silently dropped it on an SSRC change / reconnect) and
 *  needs recreating. Generous enough to avoid false positives from normal
 *  network jitter, short enough to recover within the same sentence. */
const SPEAKING_WATCHDOG_MS = 2_500;

/** Minimum interval between audio subscription resubscribes. Prevents rapid
 *  cascade loops when Discord closes a new subscription immediately (e.g.
 *  during voice connection teardown of a previous subscription for the same
 *  user). The speaking-start handler or health check will retry later. */
const MIN_RESUBSCRIBE_INTERVAL_MS = 3_000;

function log(guildId: string, ...args: unknown[]): void {
  console.log(`[DiscordMeetingRoom:${guildId}]`, ...args);
}

interface ActiveSubscription {
  discordUserId: string;
  opusStream: AudioReceiveStream;
  decoder: prism.opus.Decoder;
  /** Ties async events (error/close/watchdog) back to the specific
   *  subscription instance they came from, so a stale event from a
   *  just-replaced subscription can never be mistaken for a live one. */
  generation: number;
}

/**
 * Runs one Daily Scrum inside a Discord voice channel. Built on top of
 * MeetingStateService and GeminiLiveService — same turn-taking logic, same
 * Gemini system prompt, same standup data model as this project has used
 * throughout. Discord is now the only meeting transport this app drives;
 * audio in/out comes from Discord's voice gateway.
 *
 * Audio-in design: ONE continuous subscription per speaker turn, opened the
 * moment it becomes their turn and torn down only when the turn ends —
 * NOT re-opened per speaking burst. An earlier version subscribed with
 * `EndBehaviorType.AfterSilence(800ms)` and re-subscribed on each Discord
 * "speaking start" event; any natural pause in speech (i.e. every sentence)
 * closed that subscription, and re-opening it reliably on the next burst
 * turned out to be exactly the bug that made the bot go silent after the
 * first exchange. Using `EndBehaviorType.Manual` and holding the stream
 * open for the whole turn — continuous capture, Gemini's own VAD decides
 * where speech starts/ends — removes that whole class of bug.
 *
 * Two further reliability layers on top of that (see subscribeToCurrentSpeaker
 * and the speaking-start handler in start()):
 *  - Self-healing: if the live subscription dies for any reason mid-turn
 *    (error, or a silent close with no error at all — a known rough edge
 *    when Discord voice reconnects/changes SSRC), it's recreated
 *    automatically instead of leaving the bot deaf for the rest of the turn.
 *  - A short watchdog after every "speaking start" event confirms audio is
 *    actually arriving; if not, treats it the same as a dead subscription.
 */
export class DiscordMeetingRoom {
  private stateService = new MeetingStateService();
  private gemini: GeminiLiveService | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private outputStream: PassThrough | null = null;

  private discordToParticipant = new Map<string, string>();
  private participantToDiscord = new Map<string, string>();

  private currentSub: ActiveSubscription | null = null;
  private subscriptionGeneration = 0;
  private lastPacketAt = 0;
  private lastSubscribedAt = 0;

  private audioPacketsReceived = 0;
  private audioChunksSentToGemini = 0;
  private audioChunksDroppedByGate = 0;
  private audioPacketsSent = 0; // chunks sent to Discord (Gemini's spoken responses)
  private peakLevelSinceHeartbeat = 0;

  /** Continuous Opus encoder for AI → Discord playback. Created once in
   *  start() and fed raw PCM chunks from Gemini. The encoder's output is
   *  piped to an AudioResource with StreamType.Opus, which the AudioPlayer
   *  reads as discrete packets — unlike StreamType.Raw, this never causes
   *  the player to go Idle between chunks, eliminating the stutter bug. */
  private opusEncoder: prism.opus.Encoder | null = null;

  /** Per-turn breakdown, reset each time a new speaker's subscription opens
   *  — logged at handoff so the echo-gate's cost is directly visible turn
   *  by turn, instead of only as a cumulative total. */
  private turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: 0 };

  private timerId: ReturnType<typeof setInterval> | null = null;
  private timeLimitFired = false;
  private stopped = false;

  /** True while the bot is actively speaking (plus a short safety margin
   *  after Discord confirms playback actually finished) — see
   *  subscribeToCurrentSpeaker() for why mic forwarding is paused during
   *  this window. */
  private aiSpeaking = false;
  /** True once Gemini has told us it's done sending audio for the current
   *  turn. aiSpeaking only clears once this AND the audio player both agree
   *  playback is actually finished — see the AudioPlayerStatus.Idle handler
   *  and onAudioDone below. */
  private geminiDoneSendingAudio = false;

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
    const state = this.stateService.getState();
    const silenceSeconds = this.currentSub ? (Date.now() - this.lastPacketAt) / 1000 : 0;
    return {
      ...state,
      diagnostics: {
        packetsDecoded: this.audioPacketsReceived,
        peakLevel: this.peakLevelSinceHeartbeat,
        chunksSentToGemini: this.audioChunksSentToGemini,
        chunksDroppedByGate: this.audioChunksDroppedByGate,
        chunksSentToDiscord: this.audioPacketsSent,
        resubscribes: this.turnStats.resubscribes,
        aiSpeaking: this.aiSpeaking,
        geminiDoneSendingAudio: this.geminiDoneSendingAudio,
        silenceSeconds: Math.round(silenceSeconds * 10) / 10,
      },
    };
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

    this.connection.receiver.speaking.on('start', (discordUserId) => {
      const participantId = this.discordToParticipant.get(discordUserId);
      log(this.guildId, `speaking start: ${discordUserId} (${participantId ? 'known participant' : 'unknown/bot'})`);

      if (!participantId || participantId !== this.stateService.currentSpeakerId) return; // not their turn — nothing to do

      // Expedite mic reopen: if the user starts speaking while Gemini has
      // signaled it's done, we don't need to wait for the safety timer.
      if (this.geminiDoneSendingAudio && this.aiSpeaking) {
        log(this.guildId, 'expediting mic reopen — user speaking while AI just finished');
        this.aiSpeaking = false;
      }

      if (!this.currentSub) {
        // No live subscription at all right now — e.g. it died silently
        // earlier and nothing since then has triggered a recreate. Fix it now.
        log(this.guildId, 'no active subscription for current speaker on speaking-start — resubscribing');
        this.turnStats.resubscribes++;
        this.subscribeToCurrentSpeaker();
        return;
      }

      // Watchdog: Discord says they just started talking — confirm actual
      // decoded audio follows within a couple seconds. If the subscription
      // looks alive (no error/close event fired) but is quietly not
      // delivering anything — the exact failure mode with no other symptom
      // than intermittent silence — this is what catches it.
      const checkFromTime = Date.now();
      const generationAtCheck = this.currentSub.generation;
      setTimeout(() => {
        if (this.stopped) return;
        if (this.currentSub?.generation !== generationAtCheck) return; // already replaced by the time this fires
        if (this.lastPacketAt < checkFromTime) {
          log(this.guildId, `watchdog: no audio ${SPEAKING_WATCHDOG_MS}ms after speaking-start for ${discordUserId} — resubscribing`);
          this.turnStats.resubscribes++;
          this.currentSub = null;
          this.subscribeToCurrentSpeaker();
        }
      }, SPEAKING_WATCHDOG_MS);
    });

    this.player = createAudioPlayer();
    this.player.on('error', (err) => log(this.guildId, 'audio player error:', err.message));
    this.player.on('stateChange', (oldState, newState) => {
      log(this.guildId, `audio player state: ${oldState.status} -> ${newState.status}`);
    });
    // With the continuous Opus encoder pipeline (StreamType.Opus), the
    // AudioPlayer reads discrete Opus packets and never goes Idle between
    // chunks — it only goes Idle when the underlying stream actually ends
    // (on stop). The Idle handler here is a belt-and-suspenders fallback
    // for edge cases (e.g. very short replies where the encoder finishes
    // before geminiDoneSendingAudio fires). The main reopen signal is
    // now driven by onAudioDone in the Gemini callback above.
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.maybeReopenMic();
    });
    this.connection.subscribe(this.player);

    // Continuous Opus pipeline: Gemini PCM → encoder → PassThrough → AudioPlayer
    // Uses StreamType.Opus so the player never goes Idle between chunks.
    this.opusEncoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.outputStream = new PassThrough();
    this.opusEncoder.pipe(this.outputStream);
    const opusResource = createAudioResource(this.outputStream, { inputType: StreamType.Opus });
    this.player.play(opusResource);

    this.stateService.startMeeting();
    this.subscribeToCurrentSpeaker();

    this.gemini = new GeminiLiveService(this.stateService, {
      onAudioChunk: (chunk) => {
        this.aiSpeaking = true;
        this.geminiDoneSendingAudio = false;
        this.playAudioChunk(chunk);
      },
      onAudioDone: () => {
        this.geminiDoneSendingAudio = true;
        // With continuous Opus streaming, the player stays active as long
        // as the encoder keeps producing packets. maybeReopenMic checks
        // geminiDoneSendingAudio and reopens the mic after a short safety
        // delay — no need to check the player's Idle state here anymore.
        this.maybeReopenMic();
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
    //  - "dropped by gate" climbing fast relative to "decoded" -> the
    //    echo-prevention window is eating real speech, not just echo —
    //    a sign MIC_REOPEN_SAFETY_MS or the gate logic itself needs a look.
    //  - "resubscribes" > 0 -> the self-healing logic had to kick in at
    //    least once — worth knowing even when it works, since a high count
    //    points at a flaky underlying connection.
    setInterval(() => {
      if (this.stopped) return;
      log(
        this.guildId,
        `audio — decoded: ${this.audioPacketsReceived}, peak level: ${this.peakLevelSinceHeartbeat.toFixed(3)}, ` +
          `to Gemini: ${this.audioChunksSentToGemini}, dropped by gate: ${this.audioChunksDroppedByGate}, ` +
          `to Discord: ${this.audioPacketsSent}, resubscribes: ${this.turnStats.resubscribes}`
      );
      this.peakLevelSinceHeartbeat = 0;
    }, 15_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return; // idempotent — natural completion + explicit stop can race
    this.stopped = true;

    this.clearTimer();
    this.teardownSubscription();

    // Each step is isolated: a failure in one (e.g. the voice connection
    // already dropped) must not prevent the others from running, and must
    // never prevent onEnded() from firing.
    try { this.gemini?.disconnect(); } catch (err) { log(this.guildId, 'gemini disconnect failed:', err); }
    this.gemini = null;

    try { this.opusEncoder?.destroy(); } catch (err) { log(this.guildId, 'opus encoder destroy failed:', err); }
    this.opusEncoder = null;

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

  // ── Mic gating (echo prevention) ────────────────────────────────────────────

  /** Reopens the mic once Gemini has signaled it's done sending audio.
   *  The safety delay covers the final frame in flight — with continuous
   *  Opus streaming the player doesn't go Idle between chunks, so Idle
   *  is no longer a reliable signal. Instead, onAudioDone drives this. */
  private maybeReopenMic(): void {
    if (!this.geminiDoneSendingAudio) return;
    setTimeout(() => {
      if (this.stopped) return;
      this.aiSpeaking = false;
      log(this.guildId, 'mic reopened');
    }, MIC_REOPEN_SAFETY_MS);
  }

  // ── Audio in: one continuous subscription for whoever's turn it is ─────────

  private subscribeToCurrentSpeaker(): void {
    // Throttle: prevent rapid cascade when Discord immediately closes a
    // freshly created subscription during voice connection state changes.
    const now = Date.now();
    if (now - this.lastSubscribedAt < MIN_RESUBSCRIBE_INTERVAL_MS) {
      log(this.guildId, 'subscribeToCurrentSpeaker throttled — too soon');
      return;
    }
    this.lastSubscribedAt = now;

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
    this.turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: this.turnStats.resubscribes };
    this.lastPacketAt = Date.now();

    // Manual end behavior: the stream stays open for this person's ENTIRE
    // turn regardless of pauses — Discord simply sends no packets during
    // silence, it does not close the stream. Only WE close it, when the
    // turn changes or the meeting ends. This is the key fix — see the class
    // doc comment above for why AfterSilence-based re-subscription broke.
    const opusStream = this.connection.receiver.subscribe(discordUserId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const generation = ++this.subscriptionGeneration;
    this.currentSub = { discordUserId, opusStream, decoder, generation };

    // Self-healing: any of these three signals means this subscription is
    // no longer delivering audio, whether or not an 'error' was ever
    // raised — a plain, un-errored 'close' is a real, known way Discord
    // voice subscriptions die (e.g. on an SSRC change from a reconnect).
    // The generation check discards stale events from a subscription
    // that's already been replaced, so this can never fight a healthy one.
    const onDied = (reason: string) => {
      if (this.stopped) return;
      if (this.currentSub?.generation !== generation) return;
      log(this.guildId, `subscription for ${discordUserId} ended unexpectedly (${reason}) — will recover on next speaking start or health tick`);
      this.turnStats.resubscribes++;
      this.currentSub = null;
    };
    opusStream.on('error', (err) => onDied(`opus stream error: ${err.message}`));
    opusStream.on('close', () => onDied('opus stream closed'));
    decoder.on('error', (err) => onDied(`decoder error: ${err.message}`));

    opusStream.pipe(decoder);

    decoder.on('data', (pcm48kStereo: Buffer) => {
      this.audioPacketsReceived++;
      this.turnStats.received++;
      this.lastPacketAt = Date.now();

      // Validate expected frame size: 20ms of 48kHz stereo = 3840 bytes
      if (pcm48kStereo.length !== 3840) {
        log(this.guildId, `unexpected PCM frame: ${pcm48kStereo.length} bytes (expected 3840)`);
      }

      const pcm16kMono = discord48kStereoToGemini16kMono(pcm48kStereo);

      const level = pcm16PeakLevel(pcm16kMono);
      if (level > this.peakLevelSinceHeartbeat) this.peakLevelSinceHeartbeat = level;

      // Dynamic echo gate: instead of hard-dropping audio while the bot
      // speaks (which prevents barge-in entirely), apply 30 dB attenuation
      // (gain 0.03). This keeps Gemini's VAD usable for detecting
      // interruptions while suppressing feedback echoes through speakers.
      // If audio is truly for feedback reduction, there's no safe hard
      // cutoff — attenuation preserves both safety and responsiveness.
      //
      // Only fully drop audio when the peak level is near-zero (silence),
      // since sending silence over the WebSocket is a waste of bandwidth.
      if (this.aiSpeaking) {
        this.audioChunksDroppedByGate++;
        this.turnStats.droppedByGate++;
        if (level > 0.005) {
          const attenuated = applyGainPcm16(pcm16kMono, 0.03);
          this.audioChunksSentToGemini++;
          this.turnStats.sentToGemini++;
          this.gemini?.sendAudio(attenuated.toString('base64'));
        }
        return;
      }

      // Sent immediately, one Gemini message per decoded 20ms Opus packet —
      // not batched into larger chunks. Batching trades latency for fewer
      // WebSocket messages; for a live voice conversation the latency cost
      // isn't worth it, and 50 small messages/sec is not meaningfully
      // expensive for a single active call.
      this.audioChunksSentToGemini++;
      this.turnStats.sentToGemini++;
      this.gemini?.sendAudio(pcm16kMono.toString('base64'));
    });
  }

  private teardownSubscription(): void {
    if (!this.currentSub) return;

    log(
      this.guildId,
      `turn summary for ${this.currentSub.discordUserId}: ${this.turnStats.received} received, ` +
        `${this.turnStats.sentToGemini} sent to Gemini, ${this.turnStats.droppedByGate} dropped by echo-gate, ` +
        `${this.turnStats.resubscribes} resubscribe(s)`
    );

    const { opusStream, decoder } = this.currentSub;
    try { decoder.destroy(); } catch { /* already closed */ }
    try { opusStream.destroy(); } catch { /* already closed */ }
    this.currentSub = null;
  }

  // ── Audio out: Gemini's speech → Discord voice playback ─────────────────────

  private playAudioChunk(base64Pcm24kMono: string): void {
    if (!this.player || !this.opusEncoder) return;
    this.audioPacketsSent++;
    const pcm48kStereo = gemini24kMonoToDiscord48kStereo(Buffer.from(base64Pcm24kMono, 'base64'));
    this.opusEncoder.write(pcm48kStereo);
  }

  // ── Turn handoff ──────────────────────────────────────────────────────────

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

      // Health check: recreate subscription if a speaker is assigned but
      // the subscription is null (e.g. onDied nulled it) or no audio has
      // arrived for 15s. Catches silent deaths (SSRC changes, Discord
      // reconnects) that error/close events may have tripped before the
      // speaking-start handler had a chance to recover them.
      if (this.stateService.currentSpeakerId) {
        const subMissing = !this.currentSub;
        const silenceSec = this.currentSub ? (Date.now() - this.lastPacketAt) / 1000 : 99;
        if (subMissing || silenceSec > 15) {
          log(this.guildId, `health: ${subMissing ? 'subscription missing' : `no audio for ${Math.round(silenceSec)}s`} — recreating subscription`);
          this.turnStats.resubscribes++;
          this.subscribeToCurrentSpeaker();
        }
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