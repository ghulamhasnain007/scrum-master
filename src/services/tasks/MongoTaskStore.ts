import type { TaskStore, Task, TaskInput } from './TaskStore.js';
import { TaskModel, type TaskDoc } from './TaskModel.js';

function toTask(orgId: string, id: string, doc: TaskDoc): Task {
  return {
    id,
    orgId,
    title: doc.title,
    description: doc.description,
    assignee: doc.assignee,
    status: doc.status,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.getTime(),
    closedAt: doc.closedAt ? doc.closedAt.getTime() : null,
    sourceChannelId: doc.sourceChannelId,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * MongoDB-backed TaskStore — same "my database for now" simplification the
 * scheduling and ambient-channel stores already use. See
 * AMBIENT_BOT_ARCHITECTURE_PLAN.md §6 for the deferred TaigaAdapter swap.
 */
export class MongoTaskStore implements TaskStore {
  async create(orgId: string, input: TaskInput): Promise<Task> {
    const doc = await TaskModel.create({ orgId, ...input, status: 'open', closedAt: null });
    return toTask(orgId, doc._id.toString(), doc.toObject());
  }

  async close(orgId: string, taskIdOrTitle: string): Promise<Task | null> {
    let doc = null;
    if (OBJECT_ID_RE.test(taskIdOrTitle)) {
      doc = await TaskModel.findOneAndUpdate(
        { _id: taskIdOrTitle, orgId },
        { $set: { status: 'closed', closedAt: new Date() } },
        { new: true }
      ).lean().exec();
    }
    if (!doc) {
      doc = await TaskModel.findOneAndUpdate(
        { orgId, status: 'open', title: { $regex: new RegExp(escapeRegex(taskIdOrTitle), 'i') } },
        { $set: { status: 'closed', closedAt: new Date() } },
        { new: true }
      ).lean().exec();
    }
    return doc ? toTask(orgId, String(doc._id), doc) : null;
  }

  async list(orgId: string, status?: 'open' | 'closed'): Promise<Task[]> {
    const filter: Record<string, unknown> = { orgId };
    if (status) filter.status = status;
    const docs = await TaskModel.find(filter).sort({ createdAt: -1 }).lean().exec();
    return docs.map((d) => toTask(orgId, String(d._id), d));
  }

  async get(orgId: string, id: string): Promise<Task | null> {
    const doc = await TaskModel.findOne({ _id: id, orgId }).lean().exec();
    return doc ? toTask(orgId, String(doc._id), doc) : null;
  }
}
