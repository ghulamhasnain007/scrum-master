import type { FastifyInstance } from 'fastify';
import type { ScheduledMeetingStore } from '../scheduling/ScheduledMeetingStore.js';
import type { ScheduledMeetingInput } from '../scheduling/types.js';

// Matches the single-org simplification used throughout the integrations module.
const ORG_ID = 'default';

function validate(body: Partial<ScheduledMeetingInput>): string[] {
  const missing: string[] = [];
  if (!body.title?.trim()) missing.push('title');
  if (!body.guildId) missing.push('guildId');
  if (!body.channelId) missing.push('channelId');
  if (!body.recurrence) missing.push('recurrence');
  if (!body.time) missing.push('time');
  if (!body.timezone) missing.push('timezone');
  if (!body.durationMs) missing.push('durationMs');
  if (body.recurrence === 'weekly' && !body.daysOfWeek?.length) missing.push('daysOfWeek');
  if (body.recurrence === 'once' && !body.date) missing.push('date');
  return missing;
}

export default function registerScheduleRoutes(
  fastify: FastifyInstance,
  deps: { store: ScheduledMeetingStore }
): void {
  const { store } = deps;

  fastify.get('/integrations/schedules', async () => store.list(ORG_ID));

  fastify.post('/integrations/schedules', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ScheduledMeetingInput>;
    const missing = validate(body);
    if (missing.length) return reply.code(400).send({ error: `Missing required field(s): ${missing.join(', ')}` });

    const created = await store.create(ORG_ID, {
      ...(body as ScheduledMeetingInput),
      provider: 'discord',
      enabled: body.enabled ?? true,
    });
    return created;
  });

  fastify.patch('/integrations/schedules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Partial<ScheduledMeetingInput> & { enabled?: boolean };
    const updated = await store.update(ORG_ID, id, patch);
    if (!updated) return reply.code(404).send({ error: 'Schedule not found' });
    return updated;
  });

  fastify.delete('/integrations/schedules/:id', async (req) => {
    const { id } = req.params as { id: string };
    await store.delete(ORG_ID, id);
    return { deleted: true, id };
  });
}
