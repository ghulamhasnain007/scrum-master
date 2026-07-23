export type MeetingPhase =
  | 'idle'
  | 'greeting'
  | 'yesterday'
  | 'today'
  | 'blockers'
  | 'summary'
  | 'completed';

export interface StandupData {
  yesterday: string[];
  today: string[];
  blockers: string[];
  missingInfo: string[];
  completionPercentage: number;
}

export interface ParticipantStandup extends StandupData {
  participantId: string;
}

export interface Participant {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  hasSpoken: boolean;
  connected: boolean;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  participantId?: string;
  participantName?: string;
  content: string;
  timestamp: number;
}

export interface MeetingState {
  id: string;
  phase: MeetingPhase;
  startedAt: number | null;
  durationMs: number;
  participants: Participant[];
  turnOrder: string[];
  currentSpeakerId: string | null;
  standups: Record<string, ParticipantStandup>;
  transcript: TranscriptEntry[];
  isActive: boolean;
}

// ── Messages: Backend → Frontend ──────────────────────────────────────────────
export type ServerMessage =
  | { type: 'meeting_state'; state: MeetingState }
  | { type: 'joined'; participantId: string; participants: Participant[] }
  | { type: 'participant_update'; participants: Participant[] }
  | { type: 'transcript_delta'; entry: TranscriptEntry }
  | { type: 'audio_chunk'; chunk: string }   // base64 PCM16 24 kHz
  | { type: 'audio_done' }
  | { type: 'standup_update'; participantId: string; data: StandupData }
  | { type: 'phase_change'; phase: MeetingPhase }
  | { type: 'turn_change'; currentSpeakerId: string | null }
  | { type: 'error'; message: string }
  | { type: 'meeting_started'; meetingId: string }
  | { type: 'meeting_ended' };

// ── Messages: Frontend → Backend ──────────────────────────────────────────────
export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'start_meeting'; durationMs?: number }
  | { type: 'end_meeting' }
  | { type: 'audio_chunk'; chunk: string }   // base64 PCM16 16 kHz from mic
  | { type: 'audio_stream_end' }
  | { type: 'ping' };
