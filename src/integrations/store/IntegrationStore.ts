import type { OrgProviderConnection, OAuthTokenSet, ProviderId } from '../types.js';
import { TokenCipher } from '../crypto/TokenCipher.js';

/**
 * Storage contract for per-org provider connections + encrypted tokens.
 * The rest of the module only depends on this interface — swap
 * InMemoryIntegrationStore for a real Postgres/Mongo-backed implementation
 * in production without touching adapters, routes, or OAuthService.
 */
export interface IntegrationStore {
  saveConnection(conn: OrgProviderConnection, tokens: OAuthTokenSet | null): Promise<void>;
  getConnection(orgId: string, provider: ProviderId): Promise<OrgProviderConnection | null>;
  getTokens(orgId: string, provider: ProviderId): Promise<OAuthTokenSet | null>;
  listConnections(orgId: string): Promise<OrgProviderConnection[]>;
  deleteConnection(orgId: string, provider: ProviderId): Promise<void>;
  setEnabled(orgId: string, provider: ProviderId, enabled: boolean): Promise<void>;
}

/** In-memory reference implementation — fine for local dev, gone on restart. */
export class InMemoryIntegrationStore implements IntegrationStore {
  private connections = new Map<string, OrgProviderConnection>();
  private tokens = new Map<string, string>(); // encrypted blob, keyed same as connections

  constructor(private readonly cipher: TokenCipher) {}

  private key(orgId: string, provider: ProviderId): string {
    return `${orgId}::${provider}`;
  }

  async saveConnection(conn: OrgProviderConnection, tokens: OAuthTokenSet | null): Promise<void> {
    this.connections.set(this.key(conn.orgId, conn.provider), conn);
    if (tokens) {
      this.tokens.set(this.key(conn.orgId, conn.provider), this.cipher.encrypt(JSON.stringify(tokens)));
    }
  }

  async getConnection(orgId: string, provider: ProviderId): Promise<OrgProviderConnection | null> {
    return this.connections.get(this.key(orgId, provider)) ?? null;
  }

  async getTokens(orgId: string, provider: ProviderId): Promise<OAuthTokenSet | null> {
    const blob = this.tokens.get(this.key(orgId, provider));
    if (!blob) return null;
    return JSON.parse(this.cipher.decrypt(blob)) as OAuthTokenSet;
  }

  async listConnections(orgId: string): Promise<OrgProviderConnection[]> {
    return [...this.connections.values()].filter((c) => c.orgId === orgId);
  }

  async deleteConnection(orgId: string, provider: ProviderId): Promise<void> {
    this.connections.delete(this.key(orgId, provider));
    this.tokens.delete(this.key(orgId, provider));
  }

  async setEnabled(orgId: string, provider: ProviderId, enabled: boolean): Promise<void> {
    const existing = this.connections.get(this.key(orgId, provider));
    if (existing) this.connections.set(this.key(orgId, provider), { ...existing, enabled });
  }
}
