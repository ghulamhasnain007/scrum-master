import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '../types.js';
import type { CredentialsStore } from './CredentialsStore.js';
import { TokenCipher } from '../crypto/TokenCipher.js';

/**
 * File-persisted CredentialsStore — encrypted JSON on disk. Useful for
 * local dev without standing up MongoDB; not meant for production/multi-
 * instance use (see MongoCredentialsStore for that). Implements the same
 * CredentialsStore interface, so switching between them is a one-line
 * change in integrations/index.ts — nothing else in the module changes.
 */
export class FileCredentialsStore implements CredentialsStore {
  constructor(
    private readonly cipher: TokenCipher,
    private readonly filePath: string
  ) {}

  private key(orgId: string, provider: ProviderId): string {
    return `${orgId}::${provider}`;
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeAll(data: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data), 'utf8');
  }

  async save(orgId: string, provider: ProviderId, credentials: Record<string, string>): Promise<void> {
    const all = await this.readAll();
    all[this.key(orgId, provider)] = this.cipher.encrypt(JSON.stringify(credentials));
    await this.writeAll(all);
  }

  async get(orgId: string, provider: ProviderId): Promise<Record<string, string> | null> {
    const all = await this.readAll();
    const blob = all[this.key(orgId, provider)];
    if (!blob) return null;
    return JSON.parse(this.cipher.decrypt(blob)) as Record<string, string>;
  }

  async isConfigured(orgId: string, provider: ProviderId): Promise<boolean> {
    return (await this.get(orgId, provider)) !== null;
  }

  async delete(orgId: string, provider: ProviderId): Promise<void> {
    const all = await this.readAll();
    delete all[this.key(orgId, provider)];
    await this.writeAll(all);
  }
}
