import type { MeetingProviderAdapter, OAuthTokenSet, MeetingIntegrationEvent, MeetingRef } from '../types.js';
import { exchangeAuthorizationCode, refreshAccessToken, toTokenSet } from './oauth2Utils.js';

export interface TeamsAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** 'common' for multi-tenant install, or a specific tenant GUID for single-tenant. */
  tenantId: string;
  /** Value set as `clientState` when the Graph change-notification subscription
   *  was created — compared against inbound webhooks to authenticate them. */
  webhookClientState: string;
}

const SCOPES = ['OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All', 'offline_access'].join(' ');

/**
 * Microsoft's real-time media path (Graph Communications Calls.Media SDK)
 * is .NET-only and must run on a Windows Server host — there's no supported
 * Node.js or Python equivalent as of early 2026. Building that is a genuinely
 * separate service, not something this adapter can own. What IS practical
 * in this stack: OAuth + post-meeting Graph transcripts + change-notification
 * webhooks, all implemented below. For live audio, either stand up the
 * .NET calling-bot service separately and feed its output into the same
 * normalized event stream, or swap in an aggregator adapter for this
 * provider — same interface, no changes needed elsewhere.
 */
export class TeamsAdapter implements MeetingProviderAdapter {
  readonly meta = {
    id: 'microsoft_teams' as const,
    displayName: 'Microsoft Teams',
    capabilities: ['oauth_connect', 'transcript_fetch', 'webhook_events'] as const,
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onlinemeeting',
    requiresAdvancedSetup: true,
    notes:
      'Transcript access uses Microsoft Graph onlineMeetings transcripts (post-meeting). Real-time audio ' +
      'requires a calling bot built on the Graph Communications Calls.Media SDK, which is .NET-only and must ' +
      'run on Windows Server — out of scope for this module. enableForMeeting() throws until that service ' +
      'exists, or plug in an aggregator adapter instead.',
  };

  constructor(private readonly config: TeamsAdapterConfig) {}

  private authUrl(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize`;
  }
  private tokenUrl(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
  }

  getAuthorizationUrl({ redirectUri, state }: { orgId: string; redirectUri: string; state: string }): string {
    const url = new URL(this.authUrl());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const raw = await exchangeAuthorizationCode(
      { tokenUrl: this.tokenUrl(), clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      { code, redirectUri, extra: { scope: SCOPES } }
    );
    return toTokenSet(raw);
  }

  async refreshToken(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!tokens.refreshToken) throw new Error('Teams token has no refresh_token to refresh with');
    const raw = await refreshAccessToken(
      { tokenUrl: this.tokenUrl(), clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      tokens.refreshToken
    );
    return toTokenSet(raw);
  }

  async revoke(): Promise<void> {
    // Microsoft identity platform has no per-token revoke endpoint for confidential
    // clients — access is actually cut off by removing the app's grant in Entra ID.
  }

  /** Graph change notifications include a clientState value set at subscription creation
   *  time — compare it, since there's no per-request signature like Zoom/Discord use. */
  verifyWebhook(_headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    const body = JSON.parse(rawBody.toString('utf8')) as { value?: Array<{ clientState?: string }> };
    return (body.value ?? []).every((n) => n.clientState === this.config.webhookClientState);
  }

  parseWebhookEvent(rawBody: Buffer): MeetingIntegrationEvent[] {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      value?: Array<{ resourceData?: { id?: string }; changeType?: string }>;
    };
    return (body.value ?? []).map((n) => {
      const meeting: MeetingRef = { provider: 'microsoft_teams', externalMeetingId: n.resourceData?.id ?? '' };
      return n.changeType === 'deleted'
        ? ({ type: 'meeting_ended', meeting } as const)
        : ({ type: 'meeting_started', meeting } as const);
    });
  }

  async fetchTranscript(tokens: OAuthTokenSet, userId: string, onlineMeetingId: string): Promise<unknown> {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${onlineMeetingId}/transcripts`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    if (!res.ok) throw new Error(`Failed to fetch Teams transcript: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
