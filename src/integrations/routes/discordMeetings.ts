import type { FastifyInstance } from 'fastify';
import type { CredentialsStore } from '../store/CredentialsStore.js';
import { getDiscordClient, listGuildVoiceChannels } from '../discord/DiscordBotClient.js';
import { startDiscordMeeting, stopDiscordMeeting, getDiscordMeeting, listActiveDiscordMeetings } from '../discord/DiscordMeetingManager.js';

// Matches the single-org simplification used throughout routes/integrations.ts.
const ORG_ID = 'default';

export default function registerDiscordMeetingRoutes(
  fastify: FastifyInstance,
  deps: { credentialsStore: CredentialsStore }
): void {
  const { credentialsStore } = deps;

  async function getBotToken(): Promise<string> {
    const creds = await credentialsStore.get(ORG_ID, 'discord');
    if (!creds?.botToken) {
      throw new Error('Discord is not configured yet — add its credentials on the Integrations tab first.');
    }
    return creds.botToken;
  }

  // ── List servers + voice channels the bot can join ───────────────────────────
  fastify.get('/integrations/discord/guilds', async (_req, reply) => {
    try {
      const botToken = await getBotToken();
      return await listGuildVoiceChannels(botToken);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to list Discord servers' });
    }
  });

  // ── Start a standup in a specific server + voice channel ─────────────────────
  fastify.post('/integrations/discord/meetings/start', async (req, reply) => {
    const { guildId, channelId, durationMs } = (req.body ?? {}) as {
      guildId?: string; channelId?: string; durationMs?: number;
    };
    if (!guildId || !channelId) return reply.code(400).send({ error: 'guildId and channelId are required' });

    try {
      const botToken = await getBotToken();
      const client = await getDiscordClient(botToken);
      await startDiscordMeeting(client, guildId, channelId, durationMs);
      return { started: true, guildId, channelId };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to start the meeting' });
    }
  });

  // ── Stop the active standup in a server ──────────────────────────────────────
  fastify.post('/integrations/discord/meetings/stop', async (req, reply) => {
    const { guildId } = (req.body ?? {}) as { guildId?: string };
    if (!guildId) return reply.code(400).send({ error: 'guildId is required' });
    await stopDiscordMeeting(guildId);
    return { stopped: true, guildId };
  });

  // ── Which servers currently have a meeting running (for UI auto-discovery) ──
  fastify.get('/integrations/discord/meetings/active', async () => {
    return { guildIds: listActiveDiscordMeetings() };
  });

  // ── Poll current meeting state (participants, phase, standup data, transcript) ─
  fastify.get('/integrations/discord/meetings/:guildId/status', async (req, reply) => {
    const { guildId } = req.params as { guildId: string };
    const room = getDiscordMeeting(guildId);
    if (!room) return reply.code(404).send({ error: 'No active meeting in that server' });
    return room.getState();
  });
}
