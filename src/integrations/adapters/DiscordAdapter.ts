import nacl from 'tweetnacl';
import type { MeetingProviderAdapter, OAuthTokenSet, MeetingIntegrationEvent, MeetingRef } from '../types.js';
import { exchangeAuthorizationCode, refreshAccessToken, toTokenSet } from './oauth2Utils.js';

export interface DiscordAdapterConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  /** Hex public key from the Discord Developer Portal > General Information. */
  publicKey: string;
}

const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const BOT_PERMISSIONS = '3145728'; // Connect + Speak in voice channels

/**
 * Discord is the most natively supported real-time path of the four: the
 * bot joins a voice channel directly over the Discord Gateway + voice UDP
 * session and streams Opus audio both ways — no meeting-transcript API,
 * no bot-vs-native-stream tradeoff like Zoom/Teams/Meet have. The tradeoff
 * is the opposite direction: that voice session is a genuinely stateful,
 * long-lived connection, which doesn't fit the stateless request/response
 * shape of this adapter — see DiscordVoiceSession for that piece.
 */
export class DiscordAdapter implements MeetingProviderAdapter {
  readonly meta = {
    id: 'discord' as const,
    displayName: 'Discord',
    capabilities: ['oauth_connect', 'webhook_events', 'realtime_audio', 'bot_join'] as const,
    docsUrl: 'https://discord.com/developers/docs/topics/voice-connections',
    notes:
      'The bot joins a voice channel directly and streams Opus audio both ways via the Discord voice gateway. ' +
      'Starting/stopping an actual standup happens through /integrations/discord/meetings/* (see ' +
      'discord/DiscordMeetingRoom.ts), not through this adapter\'s OAuth/webhook methods.',
  };

  constructor(private readonly config: DiscordAdapterConfig) {}

  getAuthorizationUrl({ redirectUri, state }: { orgId: string; redirectUri: string; state: string }): string {
    const url = new URL(DISCORD_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    // "bot" installs the assistant into the org's server; "identify" ties
    // the install back to the authorizing admin.
    url.searchParams.set('scope', 'bot identify guilds');
    url.searchParams.set('permissions', BOT_PERMISSIONS);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const raw = await exchangeAuthorizationCode(
      { tokenUrl: DISCORD_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      { code, redirectUri }
    );
    return toTokenSet(raw);
  }

  async refreshToken(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!tokens.refreshToken) throw new Error('Discord token has no refresh_token to refresh with');
    const raw = await refreshAccessToken(
      { tokenUrl: DISCORD_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      tokens.refreshToken
    );
    return toTokenSet(raw);
  }

  async revoke(tokens: OAuthTokenSet): Promise<void> {
    await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token: tokens.accessToken }),
    }).catch(() => {});
  }

  /** Discord Interactions Endpoint signature — Ed25519 over `timestamp + rawBody`. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      Buffer.from(signature, 'hex'),
      Buffer.from(this.config.publicKey, 'hex')
    );
  }

  parseWebhookEvent(rawBody: Buffer): MeetingIntegrationEvent[] {
    const body = JSON.parse(rawBody.toString('utf8')) as { type: number; guild_id?: string; channel_id?: string };
    if (body.type === 1) return []; // PING — Discord's endpoint verification handshake, no event

    const meeting: MeetingRef = { provider: 'discord', externalMeetingId: body.channel_id ?? body.guild_id ?? '' };
    return [{ type: 'meeting_started', meeting }];
  }

  /** "Enabling" the assistant for a Discord meeting means joining its voice channel. */
  // Note: joining a voice channel is NOT done through this adapter's
  // enableForMeeting() hook — that hook models a single stateless REST call,
  // which doesn't fit a long-lived Gateway + voice session. See
  // discord/DiscordMeetingRoom.ts and routes/discordMeetings.ts for the real
  // implementation, wired in separately via /integrations/discord/meetings/*.
}
