import { v4 as uuidv4 } from 'uuid';
import type {
  MeetingState,
  MeetingPhase,
  StandupData,
  ParticipantStandup,
  Participant,
  TranscriptEntry,
} from '../types/index.js';

const PARTICIPANT_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#14b8a6', '#6366f1',
];

function emptyStandup(participantId: string): ParticipantStandup {
  return {
    participantId,
    yesterday: [],
    today: [],
    blockers: [],
    missingInfo: ['yesterday work', 'today plan', 'blockers status'],
    completionPercentage: 0,
  };
}

export class MeetingStateService {
  private state: MeetingState;

  constructor(durationMs: number = 5 * 60 * 1000) {
    this.state = this.createInitialState(durationMs);
  }

  private createInitialState(durationMs: number): MeetingState {
    return {
      id: uuidv4(),
      phase: 'idle',
      startedAt: null,
      durationMs,
      participants: [],
      turnOrder: [],
      currentSpeakerId: null,
      standups: {},
      transcript: [],
      isActive: false,
    };
  }

  getState(): MeetingState {
    return {
      ...this.state,
      participants: [...this.state.participants],
      turnOrder: [...this.state.turnOrder],
      standups: { ...this.state.standups },
      transcript: [...this.state.transcript],
    };
  }

  // ── Participants (lobby, pre/post meeting) ─────────────────────────────────

  addParticipant(name: string): Participant {
    const id = uuidv4();
    const participant: Participant = {
      id,
      name: name.trim().slice(0, 40) || 'Teammate',
      color: PARTICIPANT_COLORS[this.state.participants.length % PARTICIPANT_COLORS.length],
      isHost: this.state.participants.length === 0,
      hasSpoken: false,
      connected: true,
    };
    this.state.participants.push(participant);

    // Late joiners during an active meeting get appended to the turn order
    // so they still get a turn, with their own empty standup slot.
    if (this.state.isActive && !this.state.turnOrder.includes(id)) {
      this.state.turnOrder.push(id);
      this.state.standups[id] = emptyStandup(id);
    }
    return participant;
  }

  /** Meeting is active — keep their data, just mark them offline. */
  markDisconnected(participantId: string): void {
    const p = this.state.participants.find((x) => x.id === participantId);
    if (p) p.connected = false;
  }

  /** Meeting hasn't started — safe to remove them from the lobby entirely. */
  removeParticipant(participantId: string): void {
    const wasHost = this.getParticipant(participantId)?.isHost;
    this.state.participants = this.state.participants.filter((p) => p.id !== participantId);
    if (wasHost && this.state.participants.length > 0) {
      this.state.participants[0].isHost = true;
    }
  }

  getParticipant(id: string): Participant | undefined {
    return this.state.participants.find((p) => p.id === id);
  }

  // ── Meeting lifecycle ────────────────────────────────────────────────────

  startMeeting(): void {
    this.state.startedAt = Date.now();
    this.state.isActive = true;
    this.state.phase = 'greeting';
    this.state.turnOrder = this.state.participants.filter((p) => p.connected).map((p) => p.id);
    this.state.standups = {};
    for (const id of this.state.turnOrder) {
      this.state.standups[id] = emptyStandup(id);
    }
    this.state.currentSpeakerId = this.state.turnOrder[0] ?? null;
  }

  endMeeting(): void {
    this.state.isActive = false;
    this.state.phase = 'completed';
    this.state.currentSpeakerId = null;
  }

  setPhase(phase: MeetingPhase): void {
    this.state.phase = phase;
  }

  // ── Turn management ──────────────────────────────────────────────────────

  get currentSpeakerId(): string | null {
    return this.state.currentSpeakerId;
  }

  getCurrentSpeaker(): Participant | undefined {
    return this.state.currentSpeakerId ? this.getParticipant(this.state.currentSpeakerId) : undefined;
  }

  /**
   * Marks the current speaker as done and advances to the next un-spoken,
   * connected participant. Returns the next speaker, or null if everyone
   * in the turn order has now spoken.
   */
  advanceTurn(): Participant | null {
    const current = this.state.currentSpeakerId;
    if (current) {
      const p = this.getParticipant(current);
      if (p) p.hasSpoken = true;
    }
    const nextId = this.state.turnOrder.find((id) => {
      const p = this.getParticipant(id);
      return p && !p.hasSpoken && p.connected;
    });
    this.state.currentSpeakerId = nextId ?? null;
    return nextId ? this.getParticipant(nextId) ?? null : null;
  }

  // ── Transcript ───────────────────────────────────────────────────────────

  addTranscriptEntry(
    role: 'user' | 'assistant',
    content: string,
    participantId?: string
  ): TranscriptEntry {
    const participant = participantId ? this.getParticipant(participantId) : undefined;
    const entry: TranscriptEntry = {
      id: uuidv4(),
      role,
      participantId,
      participantName: participant?.name,
      content: content.trim(),
      timestamp: Date.now(),
    };
    this.state.transcript.push(entry);
    return entry;
  }

  // ── Standup data (per participant) ──────────────────────────────────────

  updateStandupData(participantId: string, data: Partial<StandupData>): ParticipantStandup {
    const existing = this.state.standups[participantId] ?? emptyStandup(participantId);
    const updated: ParticipantStandup = { ...existing, ...data, participantId };
    this.state.standups[participantId] = updated;
    return updated;
  }

  getStandup(participantId: string): ParticipantStandup {
    return this.state.standups[participantId] ?? emptyStandup(participantId);
  }

  // ── Timer ──────────────────────────────────────────────────────────────

  getElapsedMs(): number {
    if (!this.state.startedAt) return 0;
    return Date.now() - this.state.startedAt;
  }

  getRemainingMs(): number {
    return Math.max(0, this.state.durationMs - this.getElapsedMs());
  }

  getTimeRatio(): number {
    return Math.min(1, this.getElapsedMs() / this.state.durationMs);
  }

  isTimeExpired(): boolean {
    return this.state.isActive && this.getElapsedMs() >= this.state.durationMs;
  }

  /** Re-set the current speaker without marking anyone as spoken (used when
   *  recovering from a null speaker state — e.g. Discord voice input
   *  arrives after the turn had advanced past all participants). */
  setCurrentSpeakerId(participantId: string | null): void {
    this.state.currentSpeakerId = participantId;
  }

  /** Resets meeting progress but keeps the current roster (with hasSpoken cleared). */
  reset(durationMs?: number): void {
    const keepParticipants = this.state.participants.map((p) => ({ ...p, hasSpoken: false }));
    this.state = this.createInitialState(durationMs ?? this.state.durationMs);
    this.state.participants = keepParticipants;
  }
}
