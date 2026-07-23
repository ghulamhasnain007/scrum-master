import type { MeetingProviderAdapter, OAuthTokenSet, MeetingIntegrationEvent, MeetingRef } from '../types.js';
import { exchangeAuthorizationCode, refreshAccessToken, toTokenSet } from './oauth2Utils.js';

export interface GoogleMeetAdapterConfig {
  clientId: string;
  clientSecret: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
].join(' ');

/**
 * Google Meet is the most constrained of the four for real-time audio. The
 * Google Workspace Meet REST API gives OAuth + post-meeting transcripts
 * (Workspace editions with Meet transcription enabled) and webhook-style
 * push via Cloud Pub/Sub — all implemented below. True real-time audio
 * needs the Meet Media API (WebRTC-based, currently allowlisted access) —
 * NOT implemented here. enableForMeeting() throws with a clear message
 * until that's added; the practical near-term option for orgs that need
 * live Meet audio today is plugging in a third-party aggregator adapter
 * (e.g. Recall.ai/Attendee-style) behind this same MeetingProviderAdapter
 * interface instead — that's exactly the kind of swap this design supports.
 */
export class GoogleMeetAdapter implements MeetingProviderAdapter {
  readonly meta = {
    id: 'google_meet' as const,
    displayName: 'Google Meet',
    capabilities: ['oauth_connect', 'transcript_fetch', 'webhook_events'] as const,
    docsUrl: 'https://developers.google.com/workspace/meet/api/guides/overview',
    requiresAdvancedSetup: true,
    notes:
      'Transcript access uses the Workspace Meet REST API (post-meeting, requires Workspace edition with Meet ' +
      'transcription enabled). Real-time audio requires the Meet Media API (allowlisted, WebRTC) and is not ' +
      'implemented here — see enableForMeeting().',
  };

  constructor(private readonly config: GoogleMeetAdapterConfig) {}

  getAuthorizationUrl({ redirectUri, state }: { orgId: string; redirectUri: string; state: string }): string {
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline'); // request a refresh_token
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const raw = await exchangeAuthorizationCode(
      { tokenUrl: GOOGLE_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      { code, redirectUri }
    );
    return toTokenSet(raw);
  }

  async refreshToken(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!tokens.refreshToken) {
      throw new Error('Google token has no refresh_token — user must reconnect (prompt=consent) to get one');
    }
    const raw = await refreshAccessToken(
      { tokenUrl: GOOGLE_TOKEN_URL, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      tokens.refreshToken
    );
    // Google omits refresh_token on refresh responses — carry the original one forward.
    return toTokenSet({ ...raw, refresh_token: raw.refresh_token ?? tokens.refreshToken });
  }

  async revoke(tokens: OAuthTokenSet): Promise<void> {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.accessToken)}`, {
      method: 'POST',
    }).catch(() => {});
  }

  /**
   * Google Workspace Events API push notifications are delivered via Cloud
   * Pub/Sub push subscriptions, authenticated with a Google-signed JWT
   * bearer token on the request — not a shared-secret HMAC like the other
   * providers. This placeholder always returns true; production use MUST
   * replace this with verification of that JWT before trusting the payload.
   * See: https://cloud.google.com/pubsub/docs/push#authenticate-push-subscriptions
   */
  verifyWebhook(): boolean {
    return true; // TODO: verify the Google-signed Pub/Sub push JWT
  }

  parseWebhookEvent(rawBody: Buffer): MeetingIntegrationEvent[] {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      eventType?: string;
      conferenceRecord?: { name?: string };
    };
    const meeting: MeetingRef = {
      provider: 'google_meet',
      externalMeetingId: payload.conferenceRecord?.name ?? '',
    };

    if (payload.eventType === 'google.workspace.meet.conference.v2.started') {
      return [{ type: 'meeting_started', meeting }];
    }
    if (payload.eventType === 'google.workspace.meet.conference.v2.ended') {
      return [{ type: 'meeting_ended', meeting }];
    }
    return [];
  }

  /** Fetches a completed meeting's transcript. Only available after the meeting ends. */
  async fetchTranscript(tokens: OAuthTokenSet, conferenceRecordName: string): Promise<string> {
    const res = await fetch(`https://meet.googleapis.com/v2/${conferenceRecordName}/transcripts`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) throw new Error(`Failed to fetch Meet transcript: ${res.status} ${await res.text()}`);
    return res.text();
  }
}
