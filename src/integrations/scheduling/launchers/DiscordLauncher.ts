import type { MeetingLauncher } from '../SchedulerService.js';
import type { ScheduledMeeting } from '../types.js';
import type { CredentialsStore } from '../../store/CredentialsStore.js';
import { getDiscordClient } from '../../discord/DiscordBotClient.js';
import { startDiscordMeeting } from '../../discord/DiscordMeetingManager.js';

// Matches the single-org simplification used throughout the integrations module.
const ORG_ID = 'default';

/** Wakes the bot up at the scheduled time and joins the configured voice channel. */
export class DiscordLauncher implements MeetingLauncher {
  readonly provider = 'discord';

  constructor(private readonly credentialsStore: CredentialsStore) {}

  async launch(schedule: ScheduledMeeting): Promise<void> {
    const creds = await this.credentialsStore.get(ORG_ID, 'discord');
    if (!creds?.botToken) {
      throw new Error('Discord is not configured — add its credentials on the Integrations tab first.');
    }
    const client = await getDiscordClient(creds.botToken);
    await startDiscordMeeting(client, schedule.guildId, schedule.channelId, schedule.durationMs);
  }
}
