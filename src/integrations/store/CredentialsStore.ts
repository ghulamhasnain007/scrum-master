import type { ProviderId } from '../types.js';

/**
 * Storage contract for the app-level credentials an org admin enters on the
 * Integrations settings screen (Client ID/Secret, webhook secrets, etc) —
 * separate from OAuthTokenSet (IntegrationStore), which is the per-connection
 * access/refresh token that results from actually running OAuth with these
 * credentials.
 *
 * Scoped by orgId (like IntegrationStore) so this is multi-tenant-ready even
 * though the app currently only ever calls it with a single constant org id
 * — see routes/integrations.ts.
 */
export interface CredentialsStore {
  save(orgId: string, provider: ProviderId, credentials: Record<string, string>): Promise<void>;
  get(orgId: string, provider: ProviderId): Promise<Record<string, string> | null>;
  isConfigured(orgId: string, provider: ProviderId): Promise<boolean>;
  delete(orgId: string, provider: ProviderId): Promise<void>;
}
