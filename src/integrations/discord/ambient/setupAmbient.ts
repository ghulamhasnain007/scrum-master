import type { FastifyInstance } from 'fastify';
import type { Client } from 'discord.js';
import { MongoAmbientChannelStore } from './store/MongoAmbientChannelStore.js';
import { AmbientPresenceManager } from './AmbientPresenceManager.js';
import registerAmbientChannelRoutes from './routes/ambientChannels.js';
import registerAmbientTaskRoutes from './routes/ambientTasks.js';
import { MongoTaskStore } from '../../../services/tasks/MongoTaskStore.js';
import { AMBIENT_TASK_TOOLS, handleAmbientFunctionCall } from './taskActions.js';

// Matches the single-org simplification used throughout the integrations module.
const ORG_ID = 'default';

/**
 * Wires the ambient-assistant module (Feature 2) into the existing Fastify
 * app. Purely additive — called from integrations/index.ts alongside the
 * existing scheduling setup, never in place of it. See
 * AMBIENT_BOT_ARCHITECTURE_PLAN.md for the full design.
 *
 * Combines every phase built so far: presence + speaking-trigger detection
 * (A), per-speaker subscriptions with a claim model (B), the Gemini
 * AUDIO-mode session with prompt-gated silence (C), and task actions
 * backed by the built-in TaskStore (D) — no external tracker yet, per your
 * decision. Phase E (admin UI) is frontend-only and doesn't change this
 * file.
 *
 * Mongo-only for now, same simplification already made for scheduling in
 * integrations/index.ts — the caller should only invoke this when
 * MONGODB_URI is set, exactly like scheduling does.
 */
export async function setupAmbientAssistant(
  fastify: FastifyInstance,
  deps: { discordClient: Client }
): Promise<void> {
  const channelStore = new MongoAmbientChannelStore();
  const taskStore = new MongoTaskStore();

  const presence = new AmbientPresenceManager(deps.discordClient, channelStore, {
    declarations: AMBIENT_TASK_TOOLS,
    handle: (call, ctx) => handleAmbientFunctionCall(taskStore, ORG_ID, ctx.channelId, ctx.speakerName, call),
  });

  await presence.start();

  registerAmbientChannelRoutes(fastify, { store: channelStore, presence });
  registerAmbientTaskRoutes(fastify, { store: taskStore });

  fastify.log.info('[integrations] ambient assistant enabled (presence + Gemini + task actions)');
}
