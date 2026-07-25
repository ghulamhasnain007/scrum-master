import type { ScheduledMeetingStore } from './ScheduledMeetingStore.js';
import type { ScheduledMeeting } from './types.js';
import { isDue } from './timeMatch.js';

/** One of these per provider that supports auto-join — see launchers/. */
export interface MeetingLauncher {
  provider: string;
  launch(schedule: ScheduledMeeting): Promise<void>;
}

const POLL_MS = 20_000;

/**
 * Polls ScheduledMeetingStore every ~20s and fires any schedule whose local
 * wall-clock time (in its own timezone) matches right now. This is the
 * whole "bot automatically joins" mechanism — no external cron, no queue,
 * just a process-local interval, which is enough for a single backend
 * instance. If you ever run multiple backend instances, add a lock/leader
 * election around tick() so schedules don't fire twice.
 */
export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private launchers = new Map<string, MeetingLauncher>();
  private inFlight = new Set<string>();

  constructor(private readonly store: ScheduledMeetingStore) {}

  registerLauncher(launcher: MeetingLauncher): void {
    this.launchers.set(launcher.provider, launcher);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick(); // also check immediately on boot, don't wait a full interval
    console.log('[SchedulerService] started, polling every', POLL_MS / 1000, 'seconds');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    let schedules: ScheduledMeeting[];
    try {
      schedules = await this.store.listAllEnabled();
    } catch (err) {
      console.error('[SchedulerService] Failed to list schedules:', err);
      return;
    }

    const now = new Date();
    for (const schedule of schedules) {
      if (this.inFlight.has(schedule.id)) continue; // already launching from a previous tick

      const { due, dateKey } = isDue(schedule, now);
      if (!due) continue;

      this.inFlight.add(schedule.id);
      this.launch(schedule, dateKey).finally(() => this.inFlight.delete(schedule.id));
    }
  }

  private async launch(schedule: ScheduledMeeting, dateKey: string): Promise<void> {
    const launcher = this.launchers.get(schedule.provider);
    if (!launcher) {
      const message = `No launcher registered for provider "${schedule.provider}"`;
      console.error('[SchedulerService]', message);
      await this.store.recordRun(schedule.id, { dateKey, status: 'error', error: message });
      return;
    }

    console.log(`[SchedulerService] Launching "${schedule.title}" (${schedule.id})`);
    try {
      await launcher.launch(schedule);
      await this.store.recordRun(schedule.id, { dateKey, status: 'launched' });
      if (schedule.recurrence === 'once') await this.store.disable(schedule.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to launch scheduled meeting';
      console.error(`[SchedulerService] Launch failed for ${schedule.id}:`, message);
      await this.store.recordRun(schedule.id, { dateKey, status: 'error', error: message });
    }
  }
}
