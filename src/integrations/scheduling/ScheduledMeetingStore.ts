import type { ScheduledMeeting, ScheduledMeetingInput } from './types.js';

/**
 * Storage contract for scheduled meetings — same pluggability pattern as
 * CredentialsStore/IntegrationStore. Only a MongoDB implementation exists
 * today (see mongo/MongoScheduledMeetingStore.ts) since the brief is
 * "my database for now"; swapping in another backend later, or a
 * calendar-derived source that implements the same interface, needs no
 * change to the scheduler or routes.
 */
export interface ScheduledMeetingStore {
  create(orgId: string, input: ScheduledMeetingInput): Promise<ScheduledMeeting>;
  update(orgId: string, id: string, patch: Partial<ScheduledMeetingInput> & { enabled?: boolean }): Promise<ScheduledMeeting | null>;
  delete(orgId: string, id: string): Promise<void>;
  get(orgId: string, id: string): Promise<ScheduledMeeting | null>;
  list(orgId: string): Promise<ScheduledMeeting[]>;
  /** All enabled schedules across every org — what the poller actually scans. */
  listAllEnabled(): Promise<ScheduledMeeting[]>;
  recordRun(id: string, result: { dateKey: string; status: 'launched' | 'error'; error?: string }): Promise<void>;
  disable(id: string): Promise<void>;
}
