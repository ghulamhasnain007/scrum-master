import { joinVoiceChannel, entersState, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAmbientRoom, type AmbientFunctionHandling } from './DiscordAmbientRoom.js';
import type { AmbientChannelStore } from './AmbientChannelStore.js';
import type { AmbientChannelConfig } from './types.js';

const JOIN_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;

function log(guildId: string, ...args: unknown[]): void {
  console.log(`[AmbientPresenceManager:${guildId}]`, ...args);
}

/**
 * Owns the "always joined" half of the ambient assistant (architecture
 * plan §3). Joins each enabled AmbientChannelConfig's voice channel once
 * and keeps a DiscordAmbientRoom attached to it indefinitely, reconnecting
 * on drops. Never leaves on its own — only an explicit disable/delete of
 * the config (or process shutdown) tears a room down.
 *
 * Deliberately does NOT track channel occupancy or fire join/leave based
 * on who's present — presence is set-and-forget; speaking activity (inside
 * DiscordAmbientRoom) is the actual trigger. See architecture plan §1/§3.1.
 */
export class AmbientPresenceManager {
  private rooms = new Map<string, DiscordAmbientRoom>(); // keyed by configId
  private reconnecting = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly store: AmbientChannelStore,
    /** Passed in from setupAmbient.ts — task-action tools + a TaskStore-
     *  backed handler. Optional so earlier phases can construct this class
     *  without it. */
    private readonly functionHandling?: AmbientFunctionHandling
  ) {}

  /** Joins every currently-enabled config. Call once at boot. */
  async start(): Promise<void> {
    const configs = await this.store.listAllEnabled();
    for (const config of configs) {
      await this.joinConfig(config).catch((err) =>
        log(config.guildId, `initial join failed for config ${config.id}:`, err instanceof Error ? err.message : err)
      );
    }
    log('*', `started — ${configs.length} ambient channel(s) configured`);
  }

  /** Call after creating/updating a config via the API, so changes take effect without a restart. */
  async syncConfig(config: AmbientChannelConfig): Promise<void> {
    const existing = this.rooms.get(config.id);
    if (!config.enabled) {
      if (existing) {
        existing.stop();
        this.rooms.delete(config.id);
      }
      return;
    }
    if (!existing) await this.joinConfig(config);
  }

  /** Call after deleting a config, so an active room doesn't linger. */
  async removeConfig(configId: string): Promise<void> {
    const existing = this.rooms.get(configId);
    if (existing) {
      existing.stop();
      this.rooms.delete(configId);
    }
  }

  private async joinConfig(config: AmbientChannelConfig): Promise<void> {
    const guild = await this.client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Ambient channel ${config.channelId} in guild ${config.guildId} is not a voice channel`);
    }

    const connection = joinVoiceChannel({
      guildId: config.guildId,
      channelId: config.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // required — a self-deafened bot can't detect speaking events either
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    log(config.guildId, `voice connection ready for ambient channel ${config.channelId}`);

    const room = new DiscordAmbientRoom(this.client, config.guildId, config.channelId, connection, this.functionHandling);
    await room.attach();
    this.rooms.set(config.id, room);

    this.watchForDrops(config, connection);
  }

  /**
   * Reconnects on unexpected disconnects — this is the entirety of what
   * "always joined" needs to guarantee. No occupancy logic involved. A
   * dropped connection is treated as gone (room stopped, map entry
   * removed) rather than resumed, per architecture plan §8 — cleaner than
   * trying to rehydrate state against a connection object that's already
   * torn down.
   */
  private watchForDrops(config: AmbientChannelConfig, connection: VoiceConnection): void {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.reconnecting.has(config.id)) return;
      this.reconnecting.add(config.id);
      log(config.guildId, `voice connection dropped for ambient channel ${config.channelId} — reconnecting`);

      const existing = this.rooms.get(config.id);
      existing?.stop();
      this.rooms.delete(config.id);

      setTimeout(async () => {
        this.reconnecting.delete(config.id);
        try {
          const fresh = await this.store.get(config.orgId, config.id);
          if (fresh?.enabled) await this.joinConfig(fresh);
        } catch (err) {
          log(config.guildId, 'reconnect failed:', err instanceof Error ? err.message : err);
        }
      }, RECONNECT_DELAY_MS);
    });
  }

  /** For the status endpoint (routes/ambientChannels.ts). */
  listActive(): Array<ReturnType<DiscordAmbientRoom['getDiagnostics']>> {
    return [...this.rooms.values()].map((r) => r.getDiagnostics());
  }
}
