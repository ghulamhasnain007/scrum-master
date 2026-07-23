import type { MeetingProviderAdapter, ProviderFactory, ProviderId } from './types.js';

/**
 * The pluggability point: every provider registers a factory here once, and
 * everything else (OAuth flow, routes, webhooks) looks providers up
 * generically by id and builds a live adapter from stored credentials on
 * demand. Adding a new meeting platform never touches this file — it's
 * just one more `.register(someProviderFactory)` call at startup.
 */
export class ProviderRegistry {
  private factories = new Map<ProviderId, ProviderFactory>();

  register(factory: ProviderFactory): void {
    if (this.factories.has(factory.id)) {
      throw new Error(`Provider "${factory.id}" is already registered`);
    }
    this.factories.set(factory.id, factory);
  }

  getFactory(id: ProviderId): ProviderFactory {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown meeting provider: "${id}"`);
    return factory;
  }

  has(id: ProviderId): boolean {
    return this.factories.has(id);
  }

  list(): ProviderFactory[] {
    return [...this.factories.values()];
  }

  /** Builds a live adapter instance from an org's saved credentials. */
  buildAdapter(id: ProviderId, credentials: Record<string, string>): MeetingProviderAdapter {
    return this.getFactory(id).create(credentials);
  }
}

// Shared singleton — every provider factory in this module registers into this instance.
export const providerRegistry = new ProviderRegistry();
