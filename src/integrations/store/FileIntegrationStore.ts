import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OrgProviderConnection, OAuthTokenSet, ProviderId } from '../types.js';
import type { IntegrationStore } from './IntegrationStore.js';
import { TokenCipher } from '../crypto/TokenCipher.js';

interface FileShape {
  connections: OrgProviderConnection[];
  tokens: Record<string, string>; // "orgId::provider" -> encrypted OAuthTokenSet
}

/**
 * File-persisted IntegrationStore — connection status + encrypted OAuth
 * tokens survive a server restart, so once an org connects a platform it
 * stays connected. Fine for a single-instance deployment; swap for a real
 * database-backed implementation (same interface) if you need
 * multi-instance writes or higher concurrency than read-modify-write-a-JSON-
 * file safely supports.
 */
export class FileIntegrationStore implements IntegrationStore {
  constructor(
    private readonly cipher: TokenCipher,
    private readonly filePath: string
  ) {}

  private key(orgId: string, provider: ProviderId): string {
    return `${orgId}::${provider}`;
  }

  private async read(): Promise<FileShape> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as FileShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { connections: [], tokens: {} };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async saveConnection(conn: OrgProviderConnection, tokens: OAuthTokenSet | null): Promise<void> {
    const data = await this.read();
    const idx = data.connections.findIndex((c) => c.orgId === conn.orgId && c.provider === conn.provider);
    if (idx >= 0) data.connections[idx] = conn;
    else data.connections.push(conn);

    if (tokens) {
      data.tokens[this.key(conn.orgId, conn.provider)] = this.cipher.encrypt(JSON.stringify(tokens));
    }
    await this.write(data);
  }

  async getConnection(orgId: string, provider: ProviderId): Promise<OrgProviderConnection | null> {
    const data = await this.read();
    return data.connections.find((c) => c.orgId === orgId && c.provider === provider) ?? null;
  }

  async getTokens(orgId: string, provider: ProviderId): Promise<OAuthTokenSet | null> {
    const data = await this.read();
    const blob = data.tokens[this.key(orgId, provider)];
    if (!blob) return null;
    return JSON.parse(this.cipher.decrypt(blob)) as OAuthTokenSet;
  }

  async listConnections(orgId: string): Promise<OrgProviderConnection[]> {
    const data = await this.read();
    return data.connections.filter((c) => c.orgId === orgId);
  }

  async deleteConnection(orgId: string, provider: ProviderId): Promise<void> {
    const data = await this.read();
    data.connections = data.connections.filter((c) => !(c.orgId === orgId && c.provider === provider));
    delete data.tokens[this.key(orgId, provider)];
    await this.write(data);
  }

  async setEnabled(orgId: string, provider: ProviderId, enabled: boolean): Promise<void> {
    const data = await this.read();
    const conn = data.connections.find((c) => c.orgId === orgId && c.provider === provider);
    if (conn) conn.enabled = enabled;
    await this.write(data);
  }
}
