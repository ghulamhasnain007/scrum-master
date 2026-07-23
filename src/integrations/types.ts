/**
 * Core contract for the meeting-platform integration layer.
 *
 * Design goal: every adapter (Zoom, Google Meet, Teams, Discord, or any
 * future provider) implements the same MeetingProviderAdapter interface.
 * The rest of the system — routes, OAuth orchestration, storage — never
 * branches on provider name; it only branches on declared `capabilities`.
 * Adding a new provider means writing one adapter class and registering it;
 * nothing else in this module changes.
 */

export type ProviderId = 'zoom' | 'google_meet' | 'microsoft_teams' | 'discord' | (string & {});

/**
 * Not every platform can do the same things. Being honest about this per
 * adapter (rather than pretending uniform support) is the whole point —
 * see each adapter's `notes` for why.
 */
export type IntegrationCapability =
  | 'oauth_connect'    // org can connect an account via OAuth2
  | 'webhook_events'   // provider pushes meeting lifecycle events to us
  | 'realtime_audio'   // adapter can stream live audio to the AI assistant
  | 'transcript_fetch' // adapter can fetch a transcript after the meeting
  | 'bot_join';        // adapter can programmatically join a meeting/call

export interface ProviderMetadata {
  id: ProviderId;
  displayName: string;
  capabilities: readonly IntegrationCapability[];
  docsUrl?: string;
  /** True if full real-time support needs extra infra beyond this module
   *  (e.g. a separate Windows/.NET service, or a third-party aggregator). */
  requiresAdvancedSetup?: boolean;
  notes?: string;
}

/** Describes one field an org admin fills in on the Integrations settings
 *  screen (Client ID, Client Secret, etc). Drives the dynamic settings form
 *  on the frontend — no code changes needed there when a new provider's
 *  fields differ from the others. */
export interface CredentialField {
  key: string;
  label: string;
  /** Masked in the UI and never echoed back by GET /credentials once saved. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

/**
 * A provider's registration in the pluggability layer: static metadata +
 * the credential fields it needs + a factory that turns saved credentials
 * into a live adapter instance. Adapters are built on demand from stored,
 * encrypted credentials rather than constructed once at boot from env
 * vars — that's what lets an org configure/reconfigure a platform from the
 * UI without restarting the server.
 */
export interface ProviderFactory extends ProviderMetadata {
  credentialFields: CredentialField[];
  create(credentials: Record<string, string>): MeetingProviderAdapter;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null; // epoch ms; null = unknown/non-expiring
  scope?: string;
  raw?: Record<string, unknown>;
}

export interface OrgProviderConnection {
  orgId: string;
  provider: ProviderId;
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  connectedAt: number | null;
  connectedBy?: string;         // user id who authorized the connection
  externalAccountId?: string;   // Zoom account id / Workspace domain / tenant id / guild id
  enabled: boolean;             // org can stay connected but toggle off without disconnecting
  lastError?: string;
}

export interface MeetingRef {
  provider: ProviderId;
  externalMeetingId: string;
  joinUrl?: string;
  topic?: string;
  scheduledStart?: number;
}

/** Normalized events every adapter maps its provider-specific payloads onto. */
export type MeetingIntegrationEvent =
  | { type: 'meeting_started'; meeting: MeetingRef }
  | { type: 'meeting_ended'; meeting: MeetingRef }
  | { type: 'participant_joined'; meeting: MeetingRef; participantName: string; externalParticipantId: string }
  | { type: 'participant_left'; meeting: MeetingRef; externalParticipantId: string }
  | { type: 'audio_chunk'; meeting: MeetingRef; participantId: string; base64Pcm16: string; sampleRate: number }
  | { type: 'transcript_segment'; meeting: MeetingRef; participantId?: string; text: string; timestamp: number }
  | { type: 'error'; meeting?: MeetingRef; message: string };

export interface MeetingProviderAdapter {
  readonly meta: ProviderMetadata;

  /** Build the URL to send the org admin to, to start OAuth consent. */
  getAuthorizationUrl(params: { orgId: string; redirectUri: string; state: string }): string;

  /** Exchange the OAuth callback code for tokens to persist. */
  exchangeCode(params: { code: string; redirectUri: string }): Promise<OAuthTokenSet>;

  /** Refresh an expiring token. Throws if the stored tokens can't be refreshed. */
  refreshToken(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;

  /** Revoke stored tokens with the provider (best-effort — never throws). */
  revoke(tokens: OAuthTokenSet): Promise<void>;

  /** Verify an inbound webhook request genuinely came from the provider. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean;

  /** Parse a verified webhook payload into normalized integration events. */
  parseWebhookEvent(rawBody: Buffer): MeetingIntegrationEvent[];

  /**
   * Optional one-time handshake some providers require when a webhook URL is
   * first registered (e.g. Zoom's endpoint.url_validation challenge). Return
   * the response body to send back, or null if this payload isn't a
   * handshake request.
   */
  handleUrlValidation?(rawBody: Buffer): Record<string, unknown> | null;

  /**
   * Optional: actively enable the assistant for a specific meeting (Zoom
   * RTMS activation, Discord voice-channel join, etc). Only present on
   * adapters whose `meta.capabilities` includes 'realtime_audio' or
   * 'bot_join' — check that before calling.
   */
  enableForMeeting?(tokens: OAuthTokenSet, meeting: MeetingRef): Promise<void>;

  disableForMeeting?(tokens: OAuthTokenSet, meeting: MeetingRef): Promise<void>;
}
