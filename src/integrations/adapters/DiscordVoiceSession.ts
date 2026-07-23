// @ts-nocheck
/**
 * DiscordVoiceSession — ILLUSTRATIVE SKETCH, not wired into the build.
 *
 * This file is deliberately excluded from the project's tsconfig (see
 * tsconfig.json's "exclude") and needs two extra dependencies not installed
 * by default:
 *   npm install discord.js @discordjs/voice
 *
 * Why this exists as a separate file: everything else in this module is
 * stateless request/response (OAuth exchange, webhook parsing). Joining a
 * Discord voice channel is a genuinely long-lived, stateful Gateway + UDP
 * connection that has to stay open for the whole meeting — it doesn't fit
 * the same shape, so it's its own class rather than bolted onto
 * DiscordAdapter. Wire DiscordAdapter.enableForMeeting() to call into an
 * instance of this once the dependencies are added.
 *
 * Also not shown: decoding the raw Opus packets to PCM16 (via prism-media or
 * @discordjs/opus) before handing audio off to the same Gemini Live pipeline
 * the hosted meetings use — left out here to keep the sketch focused on the
 * voice-session lifecycle itself.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, VoiceConnection } from '@discordjs/voice';

export class DiscordVoiceSession {
  private client: Client;
  private connection: VoiceConnection | null = null;

  constructor(
    botToken: string,
    private readonly onAudioChunk: (userId: string, opusPacket: Buffer) => void
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client.login(botToken);
  }

  async join(guildId: string, channelId: string): Promise<void> {
    await new Promise<void>((resolve) => this.client.once('ready', () => resolve()));

    this.connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: this.client.guilds.cache.get(guildId)!.voiceAdapterCreator,
      selfDeaf: false,
    });

    this.connection.receiver.speaking.on('start', (userId) => {
      const stream = this.connection!.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
      });
      stream.on('data', (chunk: Buffer) => this.onAudioChunk(userId, chunk));
    });
  }

  leave(): void {
    this.connection?.destroy();
    this.connection = null;
  }
}
