import type { AmbientChannelStore } from '../AmbientChannelStore.js';
import type { AmbientChannelConfig, AmbientChannelInput } from '../types.js';
import { AmbientChannelModel, type AmbientChannelDoc } from './AmbientChannelModel.js';

function toConfig(orgId: string, id: string, doc: AmbientChannelDoc): AmbientChannelConfig {
  return {
    id,
    orgId,
    guildId: doc.guildId,
    channelId: doc.channelId,
    enabled: doc.enabled,
    createdAt: doc.createdAt.getTime(),
    updatedAt: doc.updatedAt.getTime(),
  };
}

/**
 * MongoDB-backed AmbientChannelStore. Mongo-only for now — the same
 * simplification integrations/index.ts already made for
 * ScheduledMeetingStore ("my database for now"). A file-backed variant can
 * be added later behind the same interface if local dev without Mongo ever
 * needs this feature specifically; nothing else would need to change.
 */
export class MongoAmbientChannelStore implements AmbientChannelStore {
  async create(orgId: string, input: AmbientChannelInput): Promise<AmbientChannelConfig> {
    const doc = await AmbientChannelModel.create({ orgId, ...input });
    return toConfig(orgId, doc._id.toString(), doc.toObject());
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<AmbientChannelInput>
  ): Promise<AmbientChannelConfig | null> {
    const doc = await AmbientChannelModel.findOneAndUpdate(
      { _id: id, orgId },
      { $set: patch },
      { new: true }
    ).lean().exec();
    return doc ? toConfig(orgId, String(doc._id), doc) : null;
  }

  async delete(orgId: string, id: string): Promise<void> {
    await AmbientChannelModel.deleteOne({ _id: id, orgId }).exec();
  }

  async get(orgId: string, id: string): Promise<AmbientChannelConfig | null> {
    const doc = await AmbientChannelModel.findOne({ _id: id, orgId }).lean().exec();
    return doc ? toConfig(orgId, String(doc._id), doc) : null;
  }

  async list(orgId: string): Promise<AmbientChannelConfig[]> {
    const docs = await AmbientChannelModel.find({ orgId }).sort({ createdAt: -1 }).lean().exec();
    return docs.map((d) => toConfig(orgId, String(d._id), d));
  }

  async listAllEnabled(): Promise<AmbientChannelConfig[]> {
    const docs = await AmbientChannelModel.find({ enabled: true }).lean().exec();
    return docs.map((d) => toConfig(d.orgId, String(d._id), d));
  }
}
