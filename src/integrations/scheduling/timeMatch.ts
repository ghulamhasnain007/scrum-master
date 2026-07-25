/**
 * Timezone-aware "is this schedule due right now" matching, delegating all
 * DST/offset handling to Intl.DateTimeFormat instead of doing manual UTC
 * offset arithmetic. The scheduler polls every ~20s and compares wall-clock
 * minute strings — simple, correct across DST transitions, and precise
 * enough for a meeting scheduler (vs. needing sub-minute accuracy).
 */

export interface LocalParts {
  /** 'Mon' | 'Tue' | ... */
  weekday: string;
  /** 'YYYY-MM-DD' in the target timezone */
  dateKey: string;
  /** 'HH:mm' 24h in the target timezone */
  hhmm: string;
}

export function getLocalParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value])) as Record<string, string>;
  return {
    weekday: parts.weekday.replace('.', ''), // some locales append a trailing period
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

export interface DueCheckInput {
  recurrence: 'once' | 'daily' | 'weekdays' | 'weekly';
  time: string;
  timezone: string;
  daysOfWeek?: string[];
  date?: string;
  lastRunDateKey: string | null;
}

export function isDue(schedule: DueCheckInput, now: Date): { due: boolean; dateKey: string } {
  const local = getLocalParts(now, schedule.timezone);

  if (local.hhmm !== schedule.time) return { due: false, dateKey: local.dateKey };
  if (schedule.lastRunDateKey === local.dateKey) return { due: false, dateKey: local.dateKey }; // already fired today

  switch (schedule.recurrence) {
    case 'once':
      return { due: local.dateKey === schedule.date, dateKey: local.dateKey };
    case 'daily':
      return { due: true, dateKey: local.dateKey };
    case 'weekdays':
      return { due: !WEEKEND.has(local.weekday), dateKey: local.dateKey };
    case 'weekly':
      return { due: (schedule.daysOfWeek ?? []).includes(local.weekday), dateKey: local.dateKey };
    default:
      return { due: false, dateKey: local.dateKey };
  }
}
