import type { FastifyInstance } from 'fastify';
import type { TaskStore } from '../../../../services/tasks/TaskStore.js';

// Matches the single-org simplification used throughout the integrations module.
const ORG_ID = 'default';

/** Read-only for now — tasks are created/closed by voice, not through the
 *  API. Gives the admin UI (and manual testing) a way to see task history. */
export default function registerAmbientTaskRoutes(fastify: FastifyInstance, deps: { store: TaskStore }): void {
  fastify.get('/integrations/ambient/tasks', async (req) => {
    const { status } = req.query as { status?: 'open' | 'closed' };
    return deps.store.list(ORG_ID, status);
  });
}
