import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MeetingProviderAdapter, OAuthTokenSet, MeetingIntegrationEvent, MeetingRef } from '../types.js';
import { exchangeAuthorizationCode, refreshAccessToken, toTokenSet } from './oauth2Utils.js';

export interface ZoomAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** From the app's Feature > Event Subscriptions page in Zoom Marketplace. */
  webhookSecretToken: string;
}

const ZOOM_AUTH_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';

/**
 * Zoom is the most mature of the four platforms for this use case. Real-time
 * audio uses Realtime Media Streams (RTMS) — a paid Zoom Developer Pack
 * feature, available to all developers since June 2025. RTMS streams
 * per-participant audio/video/transcript over a dedicated WebSocket with NO
 * bot joining the meeting; the host enables the RTMS app from inside Zoom
 * (or we can request it via enableForMeeting, permissions allowing).
 */
export class ZoomAdapter implements MeetingProviderAdapter {
  readonly meta = {
    id: 'zoom' as const,
    displayName: 'Zoom',
    capabilities: ['oauth_connect', 'webhook_events', 'realtime_audio', 'transcript_fetch'] as const,
    docsUrl: 'https://developers.zoom.us/docs/rtms/',
    notes:
      'Real-time audio uses Zoom Realtime Media Streams (RTMS), a paid Developer Pack feature. No bot joins ' +
      'the meeting — the host enables the RTMS app and Zoom streams audio/transcript directly over WebSocket ' +
      '(handled separately from this adapter, which covers OAuth + webhook lifecycle events).',
  };

  constructor(private readonly config: ZoomAdapterConfig) {}

  getAuthorizationUrl({ redirectUri, state }: { orgId: string; redirectUri: string; state: string }): string {
    const url = new URL(ZOOM_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const raw = await exchangeAuthorizationCode(
      { tokenUrl: ZOOM_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      { code, redirectUri }
    );
    return toTokenSet(raw);
  }

  async refreshToken(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!tokens.refreshToken) throw new Error('Zoom token has no refresh_token to refresh with');
    const raw = await refreshAccessToken(
      { tokenUrl: ZOOM_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      tokens.refreshToken
    );
    return toTokenSet(raw);
  }

  async revoke(tokens: OAuthTokenSet): Promise<void> {
    await fetch('https://zoom.us/oauth/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token: tokens.accessToken }),
    }).catch(() => {}); // best-effort — never block disconnect on this
  }

  /** Zoom signs webhooks as `x-zm-signature: v0=<hmac>` over `v0:<timestamp>:<rawBody>`. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    const signatureHeader = headers['x-zm-signature'];
    const timestamp = headers['x-zm-request-timestamp'];
    if (typeof signatureHeader !== 'string' || typeof timestamp !== 'string') return false;

    const message = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const expected = 'v0=' + createHmac('sha256', this.config.webhookSecretToken).update(message).digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Zoom's one-time webhook URL validation handshake (sent before signature verification is possible). */
  handleUrlValidation(rawBody: Buffer): Record<string, unknown> | null {
    const payload = JSON.parse(rawBody.toString('utf8')) as { event?: string; payload?: { plainToken?: string } };
    if (payload.event !== 'endpoint.url_validation' || !payload.payload?.plainToken) return null;

    const plainToken = payload.payload.plainToken;
    const encryptedToken = createHmac('sha256', this.config.webhookSecretToken).update(plainToken).digest('hex');
    return { plainToken, encryptedToken };
  }

  parseWebhookEvent(rawBody: Buffer): MeetingIntegrationEvent[] {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload: { object: Record<string, unknown> };
    };
    const obj = payload.payload?.object ?? {};
    const meeting: MeetingRef = {
      provider: 'zoom',
      externalMeetingId: String(obj.id ?? obj.meeting_id ?? ''),
      topic: typeof obj.topic === 'string' ? obj.topic : undefined,
    };

    switch (payload.event) {
      case 'meeting.started':
        return [{ type: 'meeting_started', meeting }];
      case 'meeting.ended':
        return [{ type: 'meeting_ended', meeting }];
      case 'meeting.participant_joined': {
        const participant = obj.participant as Record<string, unknown> | undefined;
        return [{
          type: 'participant_joined',
          meeting,
          participantName: String(participant?.user_name ?? 'Unknown'),
          externalParticipantId: String(participant?.participant_uuid ?? ''),
        }];
      }
      case 'meeting.rtms_started':
        // RTMS media itself arrives over a separate WebSocket, not this webhook —
        // this event just signals the stream is now available to connect to.
        return [{ type: 'meeting_started', meeting }];
      default:
        return [];
    }
  }

  /** Requests Zoom enable RTMS for a meeting server-side (host/account permissions allowing). */
  async enableForMeeting(tokens: OAuthTokenSet, meeting: MeetingRef): Promise<void> {
    const res = await fetch(`https://api.zoom.us/v2/live_meetings/${meeting.externalMeetingId}/rtms_app/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'start' }),
    });
    if (!res.ok) {
      throw new Error(`Failed to enable RTMS for meeting ${meeting.externalMeetingId}: ${res.status} ${await res.text()}`);
    }
  }

  async disableForMeeting(tokens: OAuthTokenSet, meeting: MeetingRef): Promise<void> {
    await fetch(`https://api.zoom.us/v2/live_meetings/${meeting.externalMeetingId}/rtms_app/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'stop' }),
    }).catch(() => {});
  }
}
