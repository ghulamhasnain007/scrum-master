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

/** How long to wait, after Discord has actually finished playing the bot's
 *  full response AND Gemini has signaled it's done sending audio, before
 *  reopening the mic. Small — just covers the last bit of network/jitter
 *  flight time for the final frame — because it's now anchored to a real
 *  "done" signal instead of being a blind guess covering both "did Discord
 *  finish playing" and "did Gemini finish talking" at once. */
const MIC_REOPEN_SAFETY_MS = 150;

/** After a participant's "speaking start" fires, how long to wait for an
 *  actual decoded audio packet before concluding the subscription is dead
 *  (e.g. Discord silently dropped it on an SSRC change / reconnect) and
 *  needs recreating. Generous enough to avoid false positives from normal
 *  network jitter, short enough to recover within the same sentence. */
const SPEAKING_WATCHDOG_MS = 2_500;

/** How often to check whether audio might be stuck. This is deliberately
 *  conservative — it only acts after a long stretch of silence (10s+) and
 *  only when the mic has been open the whole time, so it won't race ahead
 *  of the user's first utterance or fire during the AI's speaking turn.
 *  The 2 500 ms watchdog keyed off speaking.start is the primary recovery
 *  path; this is a last-resort safety net for truly silent deaths. */
const AUDIO_HEALTH_INTERVAL_MS = 4_000;
const AUDIO_HEALTH_MAX_GAP_MS = 10_000;

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
 *
 * Both of those depend on one non-obvious fix in teardownSubscription():
 * @discordjs/voice's receiver caches subscriptions by userId and only
 * clears that cache on the stream's own (always-asynchronous) 'close'
 * event — so resubscribing to the same user right after destroy() would
 * otherwise silently hand back the same dead stream instead of a fresh
 * one. See the comment there for the confirmed root cause.
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
  /** Timestamp of when the current subscription was created. The health
   *  checker uses this to avoid false-positive resubscribes during the
   *  natural silence before the user starts speaking. */
  private subCreatedAt = 0;

  private audioPacketsReceived = 0;
  private audioChunksSentToGemini = 0;
  private audioChunksDroppedByGate = 0;
  private audioPacketsSent = 0; // chunks sent to Discord (Gemini's spoken responses)
  private peakLevelSinceHeartbeat = 0;

  /** Per-turn breakdown, reset each time a new speaker's subscription opens
   *  — logged at handoff so the echo-gate's cost is directly visible turn
   *  by turn, instead of only as a cumulative total. */
  private turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: 0 };

  private timerId: ReturnType<typeof setInterval> | null = null;
  private healthCheckId: ReturnType<typeof setInterval> | null = null;
  private timeLimitFired = false;
  private stopped = false;

  /** Timestamp of the last mic reopen (aiSpeaking → false transition after
   *  playback finishes). Used by the echo gate to allow the first few
   *  hundred ms of user audio through even if aiSpeaking briefly flickers
   *  true (e.g. due to a late onAudioChunk racing with the reopen timeout). */
  private micReopenAt = 0;

  /** Tracks whether the user has spoken at least once since the current
   *  subscription was created. The health checker uses this to avoid
   *  false-positive resubscribes during the natural silence before the
   *  user's first utterance. */
  private hasReceivedAudio = false;

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

    this.connection.receiver.speaking.on('start', (discordUserId) => {
      const participantId = this.discordToParticipant.get(discordUserId);
      log(this.guildId, `speaking start: ${discordUserId} (${participantId ? 'known participant' : 'unknown/bot'})`);

      if (!participantId) return;
      // If the meeting has advanced past all participants (currentSpeakerId
      // is null), or if this isn't the current speaker's turn, ignore.
      // Exception: if currentSpeakerId is null but the meeting is still
      // active and a known participant is speaking, recover by re-setting
      // the current speaker so their audio doesn't go unheard during the
      // summary phase.
      if (participantId !== this.stateService.currentSpeakerId) {
        if (this.stateService.currentSpeakerId === null && this.stateService.getState().isActive) {
          log(this.guildId, `speaking start for ${discordUserId} while no current speaker — re-establishing`);
          this.stateService.setCurrentSpeakerId(participantId);
        } else {
          return;
        }
      }

      if (!this.currentSub) {
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
        if (this.currentSub?.generation !== generationAtCheck) return;
        if (this.lastPacketAt < checkFromTime) {
          log(this.guildId, `watchdog: no audio ${SPEAKING_WATCHDOG_MS}ms after speaking-start for ${discordUserId} — resubscribing`);
          this.turnStats.resubscribes++;
          this.teardownSubscription(); // properly clean up old sub (destroy stream, clear cache)
          this.subscribeToCurrentSpeaker();
        }
      }, SPEAKING_WATCHDOG_MS);
    });

    this.player = createAudioPlayer();
    this.player.on('error', (err) => log(this.guildId, 'audio player error:', err.message));
    this.player.on('stateChange', (oldState, newState) => {
      log(this.guildId, `audio player state: ${oldState.status} -> ${newState.status}`);
    });
    // Once the player fully drains a resource it goes Idle and detaches from
    // it — writing more PCM into that same PassThrough afterward goes
    // nowhere, because nothing is reading it anymore. This was the "no
    // audio after the greeting" bug from before: the greeting played
    // because it was the first-ever resource; every response after that was
    // written into an abandoned stream. Clearing outputStream here makes
    // the next playAudioChunk() call create + play() a fresh resource.
    //
    // This event doing double duty as the "reopen the mic" signal (below)
    // is deliberate: it fires exactly when Discord has actually finished
    // playing everything it was given, which a fixed timer can only guess
    // at. Idle can also fire on a brief mid-response gap though (Gemini
    // pausing between chunks) — only actually reopen the mic if Gemini has
    // ALSO told us it's fully done sending (geminiDoneSendingAudio).
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.outputStream = null;
      this.maybeReopenMic();
    });
    this.connection.subscribe(this.player);

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
        // Covers the case where the player already finished playing
        // everything (e.g. a very short reply) before Gemini's "done"
        // signal arrived — the Idle event above won't fire again on its
        // own, so check the player's current state directly here too.
        if (this.player?.state.status === AudioPlayerStatus.Idle) this.maybeReopenMic();
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
    this.startAudioHealthCheck();

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
    this.stopAudioHealthCheck();
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

  // ── Mic gating (echo prevention) ────────────────────────────────────────────

  /** Only actually reopens the mic once BOTH Gemini has said it's done
   *  sending audio AND the player has drained everything it was given —
   *  see the AudioPlayerStatus.Idle handler in start() for why both checks
   *  matter (an Idle blip mid-response must not reopen the mic early). */
  private maybeReopenMic(): void {
    if (!this.geminiDoneSendingAudio || !this.aiSpeaking) return;
    setTimeout(() => {
      if (!this.geminiDoneSendingAudio) return;
      this.aiSpeaking = false;
      this.micReopenAt = Date.now();
      this.lastPacketAt = Date.now(); // reset gap timer — user hasn't spoken yet
      log(this.guildId, 'mic reopened (playback confirmed finished)');
    }, MIC_REOPEN_SAFETY_MS);
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
    this.turnStats = { received: 0, sentToGemini: 0, droppedByGate: 0, resubscribes: this.turnStats.resubscribes };
    this.lastPacketAt = Date.now();
    this.subCreatedAt = Date.now();
    this.hasReceivedAudio = false;

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
      log(this.guildId, `subscription for ${discordUserId} ended unexpectedly (${reason}) — resubscribing`);
      this.turnStats.resubscribes++;
      this.currentSub = null;
      this.subscribeToCurrentSpeaker();
    };
    opusStream.on('error', (err) => onDied(`opus stream error: ${err.message}`));
    opusStream.on('close', () => onDied('opus stream closed'));
    decoder.on('error', (err) => onDied(`decoder error: ${err.message}`));

    opusStream.pipe(decoder);

    decoder.on('data', (pcm48kStereo: Buffer) => {
      this.audioPacketsReceived++;
      this.turnStats.received++;
      this.lastPacketAt = Date.now();
      this.hasReceivedAudio = true;

      const pcm16kMono = discord48kStereoToGemini16kMono(pcm48kStereo);

      const level = pcm16PeakLevel(pcm16kMono);
      if (level > this.peakLevelSinceHeartbeat) this.peakLevelSinceHeartbeat = level;

      // Discord voice gives us raw PCM with no acoustic echo cancellation
      // (unlike the browser mic path's getUserMedia echoCancellation) — if
      // we keep forwarding audio while the bot itself is talking, anything
      // its voice bleeds into the mic (speaker leakage, room echo) can make
      // Gemini think it's being interrupted and cut its own response off
      // mid-sentence. Simplest reliable fix: don't forward mic audio while
      // the bot is speaking (plus a short safety margin after — see
      // maybeReopenMic). Still counted above for heartbeat visibility.
      //
      // Grace period: if the mic was JUST reopened (within 250ms), allow
      // audio through even if aiSpeaking briefly flickers true — this
      // covers the case where a late onAudioChunk races with the reopen
      // timeout and re-locks the gate, silencing the first ~200ms of the
      // user's response.
      if (this.aiSpeaking) {
        const sinceReopen = Date.now() - this.micReopenAt;
        if (sinceReopen < 250) {
          // Grace period — let it through despite aiSpeaking
        } else {
          this.audioChunksDroppedByGate++;
          this.turnStats.droppedByGate++;
          return;
        }
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

    const { discordUserId, opusStream, decoder } = this.currentSub;

    // CRITICAL: @discordjs/voice's receiver.subscribe() method
    // (voice/dist/index.js:2158) attaches a one-shot 'close' listener
    // on EVERY AudioReceiveStream:
    //   stream.once("close", () => this.subscriptions.delete(userId));
    // When the old stream is destroyed (asynchronously emits 'close'),
    // that listener fires and deletes the subscription from the internal
    // cache — by userId, not by stream reference. If we have already
    // created a NEW subscription for the same userId by the time the
    // old stream's 'close' event fires (exactly what happens in every
    // resubscribe path), the old close handler deletes the NEW stream
    // from the cache. Subsequent RTP packets for that userId hit:
    //   const stream = this.subscriptions.get(userData.userId);
    // which returns undefined — audio disappears silently.
    //
    // Fix: remove the old stream's close listener BEFORE destroying it,
    // so the stale event can't corrupt the cache after a resubscribe.
    // We also synchronously delete the cache entry ourselves so the
    // next subscribe() call creates a genuinely new stream.
    opusStream.removeAllListeners('close');
    this.connection?.receiver.subscriptions.delete(discordUserId);

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
    }, TIMER_TICK_MS);
  }

  private clearTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  // ── Subscription health check ──────────────────────────────────────────

  /** Every AUDIO_HEALTH_INTERVAL_MS, verify the current speaker's
   *  subscription is still delivering audio. If no decoded packet arrived
   *  in the last AUDIO_HEALTH_MAX_GAP_MS while the gate is open (user
   *  should be audible), or if the subscription is null when it shouldn't
   *  be, recreate it. This catches silent deaths that the speaking.start
   *  watchdog misses — particularly continuous speech where Discord never
   *  fires another speaking.start event. */
  private startAudioHealthCheck(): void {
    this.healthCheckId = setInterval(() => {
      if (this.stopped) return;

      const speakerId = this.stateService.currentSpeakerId;
      if (!speakerId) return;

      // Never act while the AI is speaking — audio is correctly paused.
      if (this.aiSpeaking) return;

      // Only help if the subscription has never delivered a single packet.
      // Once audio has been received, the subscription is clearly working
      // — the user just isn't speaking right now, and destroying it would
      // only break the silence window Gemini needs to detect the turn end.
      if (this.hasReceivedAudio) return;

      // Don't act until the subscription is old enough that the user has
      // had a real chance to speak (avoids false-positives during the
      // natural silence before the first utterance, or right after the
      // mic reopens following AI speech).
      const age = Date.now() - this.subCreatedAt;
      if (age < AUDIO_HEALTH_MAX_GAP_MS) return;

      const hasSub = this.currentSub !== null;

      if (!hasSub) {
        log(this.guildId, 'healthcheck: no subscription while gate open — resubscribing');
        this.turnStats.resubscribes++;
        this.subscribeToCurrentSpeaker();
        return;
      }

      const gap = Date.now() - this.lastPacketAt;
      if (gap > AUDIO_HEALTH_MAX_GAP_MS) {
        log(this.guildId, `healthcheck: no audio for ${gap}ms — resubscribing`);
        this.turnStats.resubscribes++;
        this.teardownSubscription();
        this.subscribeToCurrentSpeaker();
      }
    }, AUDIO_HEALTH_INTERVAL_MS);
  }

  private stopAudioHealthCheck(): void {
    if (this.healthCheckId) {
      clearInterval(this.healthCheckId);
      this.healthCheckId = null;
    }
  }
}