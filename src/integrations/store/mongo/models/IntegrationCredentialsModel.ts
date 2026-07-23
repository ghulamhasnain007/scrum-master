import { Schema, model, models } from 'mongoose';

/**
 * One document per (orgId, provider) pair, holding the org admin's app
 * credentials (Client ID/Secret, webhook secrets, etc) for that provider —
 * AES-256-GCM encrypted as a single opaque string, never stored as
 * separate plaintext fields.
 */
export interface IntegrationCredentialsDoc {
  orgId: string;
  provider: string;
  encryptedPayload: string;
  createdAt: Date;
  updatedAt: Date;
}

const IntegrationCredentialsSchema = new Schema<IntegrationCredentialsDoc>(
  {
    orgId: { type: String, required: true },
    provider: { type: String, required: true },
    encryptedPayload: { type: String, required: true },
  },
  { timestamps: true, collection: 'integration_credentials' }
);

// One credentials document per org+provider — upserts rely on this.
IntegrationCredentialsSchema.index({ orgId: 1, provider: 1 }, { unique: true });

// `models.X ||` guards against OverwriteModelError when tsx's watch mode
// re-executes this module without restarting the process.
export const IntegrationCredentialsModel =
  models.IntegrationCredentials ??
  model<IntegrationCredentialsDoc>('IntegrationCredentials', IntegrationCredentialsSchema);
