import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyWebSocket from '@fastify/websocket';
import FastifyRawBody from 'fastify-raw-body';
import { config } from './config/index.js';
import registerWebSocket from './handlers/websocket.js';
import { setupIntegrations } from './integrations/index.js';

const fastify = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } },
  },
});

async function bootstrap() {
  await fastify.register(FastifyCors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(FastifyWebSocket);

  // Needed for provider webhook signature verification (Zoom/Discord hash
  // the exact raw bytes received) — only applied to routes that opt in via
  // `{ config: { rawBody: true } }`, so it doesn't affect anything else.
  await fastify.register(FastifyRawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    encoding: false,
  });

  fastify.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  registerWebSocket(fastify);
  await setupIntegrations(fastify);

  await fastify.listen({ port: config.port, host: config.host });

  console.log(`
🤖  AI Scrum Master — Gemini Live Backend
    HTTP  → http://${config.host}:${config.port}
    WS    → ws://${config.host}:${config.port}/ws
    Model → ${config.geminiModel}
    Integrations → http://${config.host}:${config.port}/integrations/providers
`);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
