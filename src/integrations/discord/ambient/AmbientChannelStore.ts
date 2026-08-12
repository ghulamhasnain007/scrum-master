import type { AmbientChannelConfig, AmbientChannelInput } from './types.js';

/**
 * Storage contract for ambient channel configs. Same pluggability pattern
 * as every other store in this module (CredentialsStore, IntegrationStore,
 * ScheduledMeetingStore) — routes and AmbientPresenceManager only depend on
 * this interface.
 */
export interface AmbientChannelStore {
  create(orgId: string, input: AmbientChannelInput): Promise<AmbientChannelConfig>;
  update(orgId: string, id: string, patch: Partial<AmbientChannelInput>): Promise<AmbientChannelConfig | null>;
  delete(orgId: string, id: string): Promise<void>;
  get(orgId: string, id: string): Promise<AmbientChannelConfig | null>;
  list(orgId: string): Promise<AmbientChannelConfig[]>;
  /** All enabled configs across every org — what AmbientPresenceManager scans at boot. */
  listAllEnabled(): Promise<AmbientChannelConfig[]>;
}
