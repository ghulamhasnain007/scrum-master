import { MeetingStateService } from './MeetingStateService.js';
import { GeminiLiveService } from './GeminiLiveService.js';
import type { ServerMessage, StandupData, MeetingPhase, Participant } from '../types/index.js';

type SendFn = (msg: ServerMessage) => void;

const TIMER_TICK_MS = 5_000; // state broadcast + time-limit check cadence

/**
 * Represents ONE shared Daily Scrum room. Multiple WebSocket connections
 * (one per team member's browser) register with the same MeetingSession
 * instance via join()/leave(), and everyone shares a single Gemini Live
 * conversation. Only the current speaker's audio is forwarded to Gemini —
 * see handleAudioChunk().
 */
export class MeetingSession {
  private stateService: MeetingStateService;
  private gemini: GeminiLiveService | null = null;
  private connections = new Map<string, SendFn>(); // participantId -> send
  private timerId: NodeJS.Timeout | null = null;
  private timeLimitFired = false;

  constructor() {
    this.stateService = new MeetingStateService();
  }

  // ── Participants / connections ──────────────────────────────────────────

  join(name: string, send: SendFn): Participant {
    const participant = this.stateService.addParticipant(name);
    this.connections.set(participant.id, send);

    send({
      type: 'joined',
      participantId: participant.id,
      participants: this.stateService.getState().participants,
    });
    this.broadcastState();
    this.broadcastParticipants();

    return participant;
  }

  leave(participantId: string): void {
    this.connections.delete(participantId);

    const wasActive = this.stateService.getState().isActive;
    if (wasActive) {
      this.stateService.markDisconnected(participantId);
    } else {
      this.stateService.removeParticipant(participantId);
    }

    this.broadcastParticipants();
    this.broadcastState();

    const state = this.stateService.getState();
    if (state.isActive && state.participants.every((p) => !p.connected)) {
      // Everyone left mid-meeting — tear it down.
      this.endMeeting();
    }
  }

  getState() {
    return this.stateService.getState();
  }

  isActive(): boolean {
    return this.stateService.getState().isActive;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async startMeeting(requestedBy: string, durationMs?: number): Promise<void> {
    const requester = this.stateService.getParticipant(requestedBy);
    if (!requester?.isHost) {
      this.broadcastToAll({ type: 'error', message: 'Only the host can start the meeting.' });
      return;
    }
    if (this.isActive()) return;
    if (this.stateService.getState().participants.filter((p) => p.connected).length === 0) {
      this.broadcastToAll({ type: 'error', message: 'No participants have joined yet.' });
      return;
    }

    this.cleanup();
    this.stateService.reset(durationMs);
    this.stateService.startMeeting();

    this.gemini = new GeminiLiveService(this.stateService, {
      onAudioChunk: (chunk) => this.broadcastToAll({ type: 'audio_chunk', chunk }),
      onAudioDone: () => this.broadcastToAll({ type: 'audio_done' }),

      onTranscript: (role, content, participantId) => {
        const entry = this.stateService.addTranscriptEntry(role, content, participantId);
        this.broadcastToAll({ type: 'transcript_delta', entry });
        this.broadcastState();
      },

      onStandupUpdate: (participantId, data: StandupData) => {
        this.broadcastToAll({ type: 'standup_update', participantId, data });
        this.broadcastState();
      },

      onPhaseChange: (phase: MeetingPhase) => {
        this.broadcastToAll({ type: 'phase_change', phase });
        if (phase === 'completed') {
          // Allow a few seconds for audio to finish, then close
          setTimeout(() => this.endMeeting(), 4_000);
        }
      },

      onReadyForNextParticipant: () => this.handleTurnAdvance(),

      onError: (message) => {
        console.error('[MeetingSession] Gemini error:', message);
        this.broadcastToAll({ type: 'error', message });
      },
    });

    try {
      await this.gemini.connect();

      this.broadcastToAll({ type: 'meeting_started', meetingId: this.stateService.getState().id });
      this.broadcastState();

      const first = this.stateService.getCurrentSpeaker();
      const roster = this.stateService
        .getState()
        .turnOrder.map((id) => this.stateService.getParticipant(id)?.name)
        .filter(Boolean)
        .join(', ');

      this.gemini.sendSystemHint(
        `[SYSTEM: The daily standup meeting has just started with the following team member(s), in speaking order: ${roster}. ` +
          `Greet the team warmly and briefly introduce yourself as the AI Scrum Master, then address ${first?.name ?? 'the first team member'} by name and begin their update. ` +
          `Call update_standup_data with the initial state for ${first?.name ?? 'them'} (greeting phase, 10% complete, readyForNextParticipant=false).]`
      );

      this.startTimerTick();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect to Gemini Live API';
      this.broadcastToAll({ type: 'error', message });
      this.stateService.endMeeting();
      this.broadcastState();
    }
  }

  async endMeeting(): Promise<void> {
    this.stateService.endMeeting();
    this.cleanup();
    this.broadcastToAll({ type: 'meeting_ended' });
    this.broadcastState();
  }

  // ── Audio passthrough — gated to whoever's turn it is ───────────────────────

  handleAudioChunk(participantId: string, chunk: string): void {
    if (this.stateService.currentSpeakerId !== participantId) return; // not their turn — drop it
    this.gemini?.sendAudio(chunk);
  }

  handleAudioStreamEnd(participantId: string): void {
    if (this.stateService.currentSpeakerId !== participantId) return;
    this.gemini?.sendAudioStreamEnd();
  }

  // ── Turn handoff ─────────────────────────────────────────────────────────

  private handleTurnAdvance(): void {
    const finishing = this.stateService.getCurrentSpeaker();
    const next = this.stateService.advanceTurn();

    this.broadcastToAll({ type: 'turn_change', currentSpeakerId: next?.id ?? null });
    this.broadcastState();

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private startTimerTick(): void {
    this.timerId = setInterval(() => {
      const state = this.stateService.getState();
      if (!state.isActive) {
        this.clearTimer();
        return;
      }

      this.broadcastState();

      if (this.stateService.isTimeExpired() && !this.timeLimitFired) {
        this.timeLimitFired = true;
        console.log('[MeetingSession] Time limit reached — requesting summary');
        this.gemini?.sendSystemHint(
          '[SYSTEM: The meeting time limit has been reached. Stop asking new questions. If team members remain, move through them as quickly as possible; otherwise summarize everything collected so far for the whole team, explicitly mention any missing information, then professionally close the meeting. Call update_standup_data with phase="summary" first.]'
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

  private cleanup(): void {
    this.clearTimer();
    this.timeLimitFired = false;
    this.gemini?.disconnect();
    this.gemini = null;
  }

  private broadcastToAll(msg: ServerMessage): void {
    for (const send of this.connections.values()) send(msg);
  }

  private broadcastState(): void {
    this.broadcastToAll({ type: 'meeting_state', state: this.stateService.getState() });
  }

  private broadcastParticipants(): void {
    this.broadcastToAll({ type: 'participant_update', participants: this.stateService.getState().participants });
  }
}
