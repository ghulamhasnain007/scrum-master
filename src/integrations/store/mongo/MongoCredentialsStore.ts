import type { ProviderId } from '../../types.js';
import type { CredentialsStore } from '../CredentialsStore.js';
import { TokenCipher } from '../../crypto/TokenCipher.js';
import { IntegrationCredentialsModel } from './models/IntegrationCredentialsModel.js';

/**
 * MongoDB-backed CredentialsStore. Same interface as FileCredentialsStore —
 * this is the pluggability seam in action: integrations/index.ts picks
 * whichever implementation to construct based on INTEGRATIONS_STORAGE_DRIVER,
 * and nothing else in the module (routes, OAuthService) knows or cares which
 * one is behind the CredentialsStore interface it was handed.
 */
export class MongoCredentialsStore implements CredentialsStore {
  constructor(private readonly cipher: TokenCipher) {}

  async save(orgId: string, provider: ProviderId, credentials: Record<string, string>): Promise<void> {
    const encryptedPayload = this.cipher.encrypt(JSON.stringify(credentials));
    await IntegrationCredentialsModel.findOneAndUpdate(
      { orgId, provider },
      { $set: { encryptedPayload } },
      { upsert: true }
    ).exec();
  }

  async get(orgId: string, provider: ProviderId): Promise<Record<string, string> | null> {
    const doc = await IntegrationCredentialsModel.findOne({ orgId, provider }).lean().exec();
    if (!doc) return null;
    return JSON.parse(this.cipher.decrypt(doc.encryptedPayload)) as Record<string, string>;
  }

  async isConfigured(orgId: string, provider: ProviderId): Promise<boolean> {
    const count = await IntegrationCredentialsModel.countDocuments({ orgId, provider }).exec();
    return count > 0;
  }

  async delete(orgId: string, provider: ProviderId): Promise<void> {
    await IntegrationCredentialsModel.deleteOne({ orgId, provider }).exec();
  }
}
