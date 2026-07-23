import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

/**
 * One logged-in discord.js Client per bot token, reused across every
 * Discord meeting this process runs — logging in is slow (a full Gateway
 * handshake) and there's no reason to repeat it per meeting or per request.
 *
 * Requires the "Server Members Intent" privileged intent to be enabled for
 * the bot in the Discord Developer Portal (Bot page) — without it, guild
 * member lists (needed to build the standup roster) come back incomplete.
 */
const clients = new Map<string, Client>();

export async function getDiscordClient(botToken: string): Promise<Client> {
  const existing = clients.get(botToken);
  if (existing?.isReady()) return existing;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  await client.login(botToken);
  if (!client.isReady()) {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', reject);
    });
  }

  clients.set(botToken, client);
  return client;
}

export interface GuildVoiceChannels {
  guildId: string;
  guildName: string;
  voiceChannels: { id: string; name: string; memberCount: number }[];
}

/** Lists every server the bot is in, and that server's voice channels (for the "pick where to meet" UI). */
export async function listGuildVoiceChannels(botToken: string): Promise<GuildVoiceChannels[]> {
  const client = await getDiscordClient(botToken);
  const oauthGuilds = await client.guilds.fetch();

  const results: GuildVoiceChannels[] = [];
  for (const [, oauthGuild] of oauthGuilds) {
    const guild = await oauthGuild.fetch();
    const channels = await guild.channels.fetch();
    const voiceChannels = [...channels.values()]
      .filter((c) => c?.type === ChannelType.GuildVoice)
      .map((c) => ({ id: c!.id, name: c!.name, memberCount: c!.members.filter((m) => !m.user.bot).size }));

    results.push({ guildId: guild.id, guildName: guild.name, voiceChannels });
  }
  return results;
}
