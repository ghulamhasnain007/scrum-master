/**
 * A recurring or one-off time at which the bot should automatically join a
 * meeting and run the standup — no calendar involved yet, this is purely
 * "pick a day/time, we remember it" (matching the brief: DB-backed for now,
 * calendar/other trigger sources plug in later without changing this shape).
 */
export type ScheduleRecurrence = 'once' | 'daily' | 'weekdays' | 'weekly';

/** Mon/Tue/... short form, matching Intl.DateTimeFormat's `weekday: 'short'` output — see scheduler.ts. */
export type WeekdayShort = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export type ScheduleStatus = 'idle' | 'launched' | 'error';

export interface ScheduledMeeting {
  id: string;
  orgId: string;
  title: string;

  /** Which provider's auto-join launcher handles this schedule. Only
   *  'discord' actually joins live today — see launchers/. Kept generic so
   *  Zoom/other providers (or a future calendar-triggered source) can
   *  register their own launcher later without changing this model. */
  provider: 'discord';
  guildId: string;
  channelId: string;
  guildName?: string;
  channelName?: string;

  recurrence: ScheduleRecurrence;
  /** 24h "HH:mm", interpreted in `timezone`. */
  time: string;
  /** IANA timezone name, e.g. "America/New_York". */
  timezone: string;
  /** Required when recurrence === 'weekly'. */
  daysOfWeek?: WeekdayShort[];
  /** Required when recurrence === 'once' — "YYYY-MM-DD" in `timezone`. */
  date?: string;

  durationMs: number;
  enabled: boolean;

  lastRunAt: number | null;
  lastRunDateKey: string | null;
  lastStatus: ScheduleStatus;
  lastError?: string;

  createdAt: number;
  updatedAt: number;
}

export type ScheduledMeetingInput = Omit<
  ScheduledMeeting,
  'id' | 'orgId' | 'lastRunAt' | 'lastRunDateKey' | 'lastStatus' | 'lastError' | 'createdAt' | 'updatedAt'
>;
