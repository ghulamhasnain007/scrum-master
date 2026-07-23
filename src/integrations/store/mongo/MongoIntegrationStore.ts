import type { OrgProviderConnection, OAuthTokenSet, ProviderId } from '../../types.js';
import type { IntegrationStore } from '../IntegrationStore.js';
import { TokenCipher } from '../../crypto/TokenCipher.js';
import { IntegrationConnectionModel, type IntegrationConnectionDoc } from './models/IntegrationConnectionModel.js';

function toConnection(doc: IntegrationConnectionDoc): OrgProviderConnection {
  return {
    orgId: doc.orgId,
    provider: doc.provider,
    status: doc.status,
    connectedAt: doc.connectedAt,
    connectedBy: doc.connectedBy,
    externalAccountId: doc.externalAccountId,
    enabled: doc.enabled,
    lastError: doc.lastError,
  };
}

/**
 * MongoDB-backed IntegrationStore. Same interface as FileIntegrationStore —
 * swapping between them (or adding a third backend later, e.g. Postgres) is
 * a one-line change in integrations/index.ts.
 */
export class MongoIntegrationStore implements IntegrationStore {
  constructor(private readonly cipher: TokenCipher) {}

  async saveConnection(conn: OrgProviderConnection, tokens: OAuthTokenSet | null): Promise<void> {
    const update: Partial<IntegrationConnectionDoc> = {
      status: conn.status,
      connectedAt: conn.connectedAt,
      connectedBy: conn.connectedBy,
      externalAccountId: conn.externalAccountId,
      enabled: conn.enabled,
      lastError: conn.lastError,
    };
    if (tokens) {
      update.encryptedTokens = this.cipher.encrypt(JSON.stringify(tokens));
    }
    await IntegrationConnectionModel.findOneAndUpdate(
      { orgId: conn.orgId, provider: conn.provider },
      { $set: update },
      { upsert: true }
    ).exec();
  }

  async getConnection(orgId: string, provider: ProviderId): Promise<OrgProviderConnection | null> {
    const doc = await IntegrationConnectionModel.findOne({ orgId, provider }).lean().exec();
    return doc ? toConnection(doc) : null;
  }

  async getTokens(orgId: string, provider: ProviderId): Promise<OAuthTokenSet | null> {
    const doc = await IntegrationConnectionModel.findOne({ orgId, provider }).lean().exec();
    if (!doc?.encryptedTokens) return null;
    return JSON.parse(this.cipher.decrypt(doc.encryptedTokens)) as OAuthTokenSet;
  }

  async listConnections(orgId: string): Promise<OrgProviderConnection[]> {
    const docs = await IntegrationConnectionModel.find({ orgId }).lean().exec();
    return docs.map(toConnection);
  }

  async deleteConnection(orgId: string, provider: ProviderId): Promise<void> {
    await IntegrationConnectionModel.deleteOne({ orgId, provider }).exec();
  }

  async setEnabled(orgId: string, provider: ProviderId, enabled: boolean): Promise<void> {
    await IntegrationConnectionModel.updateOne({ orgId, provider }, { $set: { enabled } }).exec();
  }
}
