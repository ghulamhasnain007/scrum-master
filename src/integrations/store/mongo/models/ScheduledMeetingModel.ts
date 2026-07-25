import { Schema, model, models } from 'mongoose';

export interface ScheduledMeetingDoc {
  orgId: string;
  title: string;
  provider: string;
  guildId: string;
  channelId: string;
  guildName?: string;
  channelName?: string;

  recurrence: 'once' | 'daily' | 'weekdays' | 'weekly';
  time: string;
  timezone: string;
  daysOfWeek?: string[];
  date?: string;

  durationMs: number;
  enabled: boolean;

  lastRunAt: number | null;
  lastRunDateKey: string | null;
  lastStatus: 'idle' | 'launched' | 'error';
  lastError?: string;

  createdAt: Date;
  updatedAt: Date;
}

const ScheduledMeetingSchema = new Schema<ScheduledMeetingDoc>(
  {
    orgId: { type: String, required: true },
    title: { type: String, required: true },
    provider: { type: String, required: true, default: 'discord' },
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    guildName: { type: String },
    channelName: { type: String },

    recurrence: { type: String, enum: ['once', 'daily', 'weekdays', 'weekly'], required: true },
    time: { type: String, required: true },
    timezone: { type: String, required: true },
    daysOfWeek: { type: [String], default: undefined },
    date: { type: String },

    durationMs: { type: Number, required: true },
    enabled: { type: Boolean, required: true, default: true },

    lastRunAt: { type: Number, default: null },
    lastRunDateKey: { type: String, default: null },
    lastStatus: { type: String, enum: ['idle', 'launched', 'error'], default: 'idle' },
    lastError: { type: String },
  },
  { timestamps: true, collection: 'scheduled_meetings' }
);

// The poller's hot-path query: "every enabled schedule", occasionally
// narrowed by org for the settings-page list view.
ScheduledMeetingSchema.index({ enabled: 1 });
ScheduledMeetingSchema.index({ orgId: 1 });

export const ScheduledMeetingModel =
  models.ScheduledMeeting ?? model<ScheduledMeetingDoc>('ScheduledMeeting', ScheduledMeetingSchema);
