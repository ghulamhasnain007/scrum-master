import { Schema, model, models } from 'mongoose';

/**
 * One document per (orgId, provider) pair, tracking the live connection
 * state produced by actually completing OAuth (status, when it connected,
 * whether it's toggled on) plus the encrypted access/refresh token set.
 * Separate from IntegrationCredentialsModel — an org can have app
 * credentials configured without ever having connected (or after
 * disconnecting), so these are independent lifecycles.
 */
export interface IntegrationConnectionDoc {
  orgId: string;
  provider: string;
  status: 'connected' | 'disconnected' | 'error' | 'pending';
  connectedAt: number | null;
  connectedBy?: string;
  externalAccountId?: string;
  enabled: boolean;
  lastError?: string;
  /** AES-256-GCM encrypted OAuthTokenSet JSON, or null if never connected. */
  encryptedTokens: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const IntegrationConnectionSchema = new Schema<IntegrationConnectionDoc>(
  {
    orgId: { type: String, required: true },
    provider: { type: String, required: true },
    status: {
      type: String,
      enum: ['connected', 'disconnected', 'error', 'pending'],
      required: true,
      default: 'disconnected',
    },
    connectedAt: { type: Number, default: null },
    connectedBy: { type: String },
    externalAccountId: { type: String },
    enabled: { type: Boolean, default: false },
    lastError: { type: String },
    encryptedTokens: { type: String, default: null },
  },
  { timestamps: true, collection: 'integration_connections' }
);

IntegrationConnectionSchema.index({ orgId: 1, provider: 1 }, { unique: true });

export const IntegrationConnectionModel =
  models.IntegrationConnection ??
  model<IntegrationConnectionDoc>('IntegrationConnection', IntegrationConnectionSchema);
