import { Schema, model, models } from 'mongoose';

export interface AmbientChannelDoc {
  orgId: string;
  guildId: string;
  channelId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AmbientChannelSchema = new Schema<AmbientChannelDoc>(
  {
    orgId: { type: String, required: true },
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'ambient_channels' }
);

// One ambient config per guild+channel — two enabled configs pointing at
// the same voice channel would just race two AmbientPresenceManager join
// attempts against each other.
AmbientChannelSchema.index({ guildId: 1, channelId: 1 }, { unique: true });
AmbientChannelSchema.index({ enabled: 1 });

// `models.X ||` guards against OverwriteModelError when tsx's watch mode
// re-executes this module without restarting the process — same pattern
// every other model in this codebase uses.
export const AmbientChannelModel =
  models.AmbientChannel ?? model<AmbientChannelDoc>('AmbientChannel', AmbientChannelSchema);
