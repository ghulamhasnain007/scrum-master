/**
 * A Discord voice channel the bot stays persistently joined to, per the
 * ambient assistant design (AMBIENT_BOT_ARCHITECTURE_PLAN.md §3). Presence
 * here is set-and-forget — this config has no schedule, no duration, no
 * grace period. Speaking activity (detected inside DiscordAmbientRoom, not
 * tracked here) is the actual trigger for anything beyond just sitting in
 * the channel.
 */
export interface AmbientChannelConfig {
  id: string;
  orgId: string;
  guildId: string;
  channelId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AmbientChannelInput = Omit<AmbientChannelConfig, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>;
