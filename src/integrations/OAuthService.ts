import { randomBytes, createHmac } from 'node:crypto';
import type { OAuthTokenSet, OrgProviderConnection, ProviderId } from './types.js';
import type { IntegrationStore } from './store/IntegrationStore.js';
import type { CredentialsStore } from './store/CredentialsStore.js';
import type { ProviderRegistry } from './ProviderRegistry.js';

interface StatePayload {
  orgId: string;
  provider: ProviderId;
  userId?: string;
  nonce: string;
  issuedAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Provider-agnostic OAuth2 orchestration: builds the signed `state` param,
 * verifies it on callback (CSRF protection), exchanges codes, and handles
 * refresh — all by delegating the provider-specific bits to whichever
 * adapter the registry builds from that org's saved credentials. This class
 * never changes when a new provider is added.
 */
export class OAuthService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: IntegrationStore,
    private readonly credentialsStore: CredentialsStore,
    private readonly stateSecret: string,
    private readonly baseRedirectUrl: string, // e.g. http://localhost:3001/integrations
    private readonly frontendUrl: string       // e.g. http://localhost:5173
  ) {}

  // private redirectUriFor(provider: ProviderId): string {
  //   return `${this.baseRedirectUrl}/${provider}/callback`;
  // }
  private redirectUriFor(baseUrl: string, provider: ProviderId): string {
    return `${baseUrl}/${provider}/callback`;
  }

  private async getAdapter(orgId: string, provider: ProviderId) {
    const credentials = await this.credentialsStore.get(orgId, provider);
    if (!credentials) {
      throw new Error(`${this.registry.getFactory(provider).displayName} hasn't been configured yet — add its credentials first.`);
    }
    return this.registry.buildAdapter(provider, credentials);
  }

  private signState(payload: StatePayload): string {
    const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.stateSecret).update(json).digest('base64url');
    return `${json}.${sig}`;
  }

  private verifyState(state: string): StatePayload {
    const [json, sig] = state.split('.');
    if (!json || !sig) throw new Error('Malformed OAuth state');
    const expected = createHmac('sha256', this.stateSecret).update(json).digest('base64url');
    if (sig !== expected) throw new Error('OAuth state signature mismatch — possible CSRF');
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')) as StatePayload;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) throw new Error('OAuth state expired, please retry');
    return payload;
  }

  /** Step 1: build the URL to redirect the org admin to for consent. */
  async startConnect(
      provider: ProviderId,
      orgId: string,
      baseUrl: string,
      userId?: string
    ): Promise<string>
  {
  const adapter = await this.getAdapter(orgId, provider); // throws early with a clear message if not configured
    const state = this.signState({
      orgId, provider, userId,
      nonce: randomBytes(8).toString('hex'),
      issuedAt: Date.now(),
    });
    return adapter.getAuthorizationUrl({ orgId, redirectUri: this.redirectUriFor(baseUrl, provider), state });
  }

  /** Step 2: handle the OAuth callback, persist tokens, return where to send the browser next. */
  async handleCallback(
    baseUrl: string,
    provider: ProviderId,
    code: string,
    state: string
  ): Promise<{ redirectTo: string }> 
  {
    const parsed = this.verifyState(state);
    if (parsed.provider !== provider) throw new Error('OAuth state/provider mismatch');
    const { orgId, userId } = parsed;

    const adapter = await this.getAdapter(orgId, provider);

    let tokens: OAuthTokenSet;
    try {
      tokens = await adapter.exchangeCode({ code, redirectUri: this.redirectUriFor(baseUrl, provider) });
    } catch (err) {
      const failed: OrgProviderConnection = {
        orgId, provider, status: 'error', connectedAt: null, enabled: false,
        lastError: err instanceof Error ? err.message : 'Token exchange failed',
      };
      await this.store.saveConnection(failed, null);
      return { redirectTo: this.resultUrl(provider, 'error', failed.lastError) };
    }

    const connection: OrgProviderConnection = {
      orgId, provider, status: 'connected', connectedAt: Date.now(), connectedBy: userId, enabled: true,
    };
    await this.store.saveConnection(connection, tokens);
    return { redirectTo: this.resultUrl(provider, 'connected') };
  }

  private resultUrl(provider: ProviderId, status: 'connected' | 'error', message?: string): string {
    const url = new URL(this.frontendUrl);
    url.searchParams.set('integration', provider);
    url.searchParams.set('status', status);
    if (message) url.searchParams.set('message', message);
    return url.toString();
  }

  /** Returns a valid access token for this org/provider, refreshing first if it's expiring. */
  async getValidTokens(orgId: string, provider: ProviderId): Promise<OAuthTokenSet> {
    const tokens = await this.store.getTokens(orgId, provider);
    if (!tokens) throw new Error(`No stored credentials for ${provider} / org ${orgId}`);

    const isExpiring = tokens.expiresAt !== null && tokens.expiresAt - Date.now() < 60_000;
    if (!isExpiring) return tokens;

    const adapter = await this.getAdapter(orgId, provider);
    const refreshed = await adapter.refreshToken(tokens);

    const conn = await this.store.getConnection(orgId, provider);
    if (conn) await this.store.saveConnection(conn, refreshed);
    return refreshed;
  }

  async disconnect(orgId: string, provider: ProviderId): Promise<void> {
    const tokens = await this.store.getTokens(orgId, provider);
    if (tokens) {
      try {
        const adapter = await this.getAdapter(orgId, provider);
        await adapter.revoke(tokens);
      } catch (err) {
        console.warn(`[OAuthService] revoke failed for ${provider}/${orgId}:`, err);
      }
    }
    await this.store.deleteConnection(orgId, provider);
  }
}
