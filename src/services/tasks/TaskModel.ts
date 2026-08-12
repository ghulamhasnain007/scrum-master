import { Schema, model, models } from 'mongoose';

export interface TaskDoc {
  orgId: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'open' | 'closed';
  createdBy: string;
  closedAt: Date | null;
  sourceChannelId: string;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<TaskDoc>(
  {
    orgId: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String },
    assignee: { type: String },
    status: { type: String, enum: ['open', 'closed'], required: true, default: 'open' },
    createdBy: { type: String, required: true },
    closedAt: { type: Date, default: null },
    sourceChannelId: { type: String, required: true },
  },
  { timestamps: true, collection: 'ambient_tasks' }
);

TaskSchema.index({ orgId: 1, status: 1 });
TaskSchema.index({ orgId: 1, title: 1 }); // supports close()'s title-match fallback

export const TaskModel = models.AmbientTask ?? model<TaskDoc>('AmbientTask', TaskSchema);
