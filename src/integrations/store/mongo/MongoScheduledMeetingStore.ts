import type { ScheduledMeeting, ScheduledMeetingInput } from '../../scheduling/types.js';
import type { ScheduledMeetingStore } from '../../scheduling/ScheduledMeetingStore.js';
import { ScheduledMeetingModel, type ScheduledMeetingDoc } from './models/ScheduledMeetingModel.js';

function toScheduledMeeting(orgId: string, id: string, doc: ScheduledMeetingDoc): ScheduledMeeting {
  return {
    id,
    orgId,
    title: doc.title,
    provider: 'discord',
    guildId: doc.guildId,
    channelId: doc.channelId,
    guildName: doc.guildName,
    channelName: doc.channelName,
    recurrence: doc.recurrence,
    time: doc.time,
    timezone: doc.timezone,
    daysOfWeek: doc.daysOfWeek as ScheduledMeeting['daysOfWeek'],
    date: doc.date,
    durationMs: doc.durationMs,
    enabled: doc.enabled,
    lastRunAt: doc.lastRunAt,
    lastRunDateKey: doc.lastRunDateKey,
    lastStatus: doc.lastStatus,
    lastError: doc.lastError,
    createdAt: doc.createdAt.getTime(),
    updatedAt: doc.updatedAt.getTime(),
  };
}

export class MongoScheduledMeetingStore implements ScheduledMeetingStore {
  async create(orgId: string, input: ScheduledMeetingInput): Promise<ScheduledMeeting> {
    const doc = await ScheduledMeetingModel.create({
      orgId,
      ...input,
      lastRunAt: null,
      lastRunDateKey: null,
      lastStatus: 'idle',
    });
    return toScheduledMeeting(orgId, doc._id.toString(), doc.toObject());
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<ScheduledMeetingInput> & { enabled?: boolean }
  ): Promise<ScheduledMeeting | null> {
    const doc = await ScheduledMeetingModel.findOneAndUpdate(
      { _id: id, orgId },
      { $set: patch },
      { new: true }
    ).lean().exec();
    return doc ? toScheduledMeeting(orgId, String(doc._id), doc) : null;
  }

  async delete(orgId: string, id: string): Promise<void> {
    await ScheduledMeetingModel.deleteOne({ _id: id, orgId }).exec();
  }

  async get(orgId: string, id: string): Promise<ScheduledMeeting | null> {
    const doc = await ScheduledMeetingModel.findOne({ _id: id, orgId }).lean().exec();
    return doc ? toScheduledMeeting(orgId, String(doc._id), doc) : null;
  }

  async list(orgId: string): Promise<ScheduledMeeting[]> {
    const docs = await ScheduledMeetingModel.find({ orgId }).sort({ createdAt: -1 }).lean().exec();
    return docs.map((d) => toScheduledMeeting(orgId, String(d._id), d));
  }

  async listAllEnabled(): Promise<ScheduledMeeting[]> {
    const docs = await ScheduledMeetingModel.find({ enabled: true }).lean().exec();
    return docs.map((d) => toScheduledMeeting(d.orgId, String(d._id), d));
  }

  async recordRun(id: string, result: { dateKey: string; status: 'launched' | 'error'; error?: string }): Promise<void> {
    await ScheduledMeetingModel.updateOne(
      { _id: id },
      {
        $set: {
          lastRunAt: Date.now(),
          lastRunDateKey: result.dateKey,
          lastStatus: result.status,
          lastError: result.status === 'error' ? result.error : undefined,
        },
      }
    ).exec();
  }

  async disable(id: string): Promise<void> {
    await ScheduledMeetingModel.updateOne({ _id: id }, { $set: { enabled: false } }).exec();
  }
}
