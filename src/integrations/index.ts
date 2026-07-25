import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { providerRegistry } from './ProviderRegistry.js';
import { allProviderFactories } from './adapters/factories.js';
import { TokenCipher } from './crypto/TokenCipher.js';
import type { IntegrationStore } from './store/IntegrationStore.js';
import type { CredentialsStore } from './store/CredentialsStore.js';
import { FileIntegrationStore } from './store/FileIntegrationStore.js';
import { FileCredentialsStore } from './store/FileCredentialsStore.js';
import { connectMongo } from './store/mongo/connection.js';
import { MongoIntegrationStore } from './store/mongo/MongoIntegrationStore.js';
import { MongoCredentialsStore } from './store/mongo/MongoCredentialsStore.js';
import { OAuthService } from './OAuthService.js';
import registerIntegrationRoutes from './routes/integrations.js';
import registerDiscordMeetingRoutes from './routes/discordMeetings.js';
import registerScheduleRoutes from './routes/schedules.js';
import { MongoScheduledMeetingStore } from './store/mongo/MongoScheduledMeetingStore.js';
import { SchedulerService } from './scheduling/SchedulerService.js';
import { DiscordLauncher } from './scheduling/launchers/DiscordLauncher.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name} for the integrations module. See backend/.env.example.`
    );
  }
  return value;
}

/**
 * Builds the two storage backends (credentials + connections/tokens) behind
 * their respective interfaces, based on INTEGRATIONS_STORAGE_DRIVER.
 *
 * This is the pluggability seam for persistence: both CredentialsStore and
 * IntegrationStore are interfaces, so adding a third backend later (e.g.
 * Postgres) means writing two classes that implement them and adding one
 * more branch here — nothing in routes.ts, OAuthService, or the adapters
 * needs to change.
 */
async function createStores(cipher: TokenCipher): Promise<{ store: IntegrationStore; credentialsStore: CredentialsStore }> {
  const driver = (process.env.INTEGRATIONS_STORAGE_DRIVER ?? 'mongo').toLowerCase();

  if (driver === 'mongo') {
    await connectMongo(requireEnv('MONGODB_URI'));
    return {
      store: new MongoIntegrationStore(cipher),
      credentialsStore: new MongoCredentialsStore(cipher),
    };
  }

  if (driver === 'file') {
    const dataDir = process.env.INTEGRATIONS_DATA_DIR ?? path.join(process.cwd(), 'data');
    return {
      store: new FileIntegrationStore(cipher, path.join(dataDir, 'integration-connections.enc.json')),
      credentialsStore: new FileCredentialsStore(cipher, path.join(dataDir, 'integration-credentials.enc.json')),
    };
  }

  throw new Error(`Unknown INTEGRATIONS_STORAGE_DRIVER "${driver}" — expected "mongo" or "file"`);
}

/**
 * Wires the integration module into the existing Fastify app. Call this
 * once from index.ts, after the raw-body plugin is registered (needed for
 * webhook signature verification — see backend/src/index.ts).
 *
 * To add a new meeting platform later: write one adapter + factory (see
 * adapters/factories.ts), add it to `allProviderFactories`, and it will
 * show up automatically in GET /integrations/providers and the settings UI.
 * No other change is needed here.
 */
export async function setupIntegrations(fastify: FastifyInstance): Promise<void> {
  for (const factory of allProviderFactories) providerRegistry.register(factory);

  const cipher = new TokenCipher(requireEnv('INTEGRATIONS_ENCRYPTION_KEY'));
  const { store, credentialsStore } = await createStores(cipher);

  const oauth = new OAuthService(
    providerRegistry,
    store,
    credentialsStore,
    requireEnv('OAUTH_STATE_SECRET'),
    process.env.INTEGRATIONS_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}/integrations`,
    process.env.CORS_ORIGIN ?? 'http://localhost:5173'
  );

  registerIntegrationRoutes(fastify, { oauth, store, credentialsStore });
  registerDiscordMeetingRoutes(fastify, { credentialsStore });

  // Scheduling is Mongo-only for now (per the brief: "my database for now"),
  // independent of INTEGRATIONS_STORAGE_DRIVER above — so this works even
  // when credentials/connections are on the file driver. If MONGODB_URI
  // isn't set at all, scheduling just doesn't come up (rather than crashing
  // boot) so local dev without Mongo still works for everything else.
  if (process.env.MONGODB_URI) {
    await connectMongo(process.env.MONGODB_URI); // no-op if already connected via createStores() above
    const scheduleStore = new MongoScheduledMeetingStore();

    const scheduler = new SchedulerService(scheduleStore);
    scheduler.registerLauncher(new DiscordLauncher(credentialsStore));
    scheduler.start();
    fastify.addHook('onClose', (_instance, done) => { scheduler.stop(); done(); });

    registerScheduleRoutes(fastify, { store: scheduleStore });
    fastify.log.info('[integrations] scheduling enabled (MongoDB)');
  } else {
    fastify.log.warn('[integrations] MONGODB_URI not set — meeting scheduling is disabled');
  }

  fastify.log.info(
    {
      providers: allProviderFactories.map((f) => f.id),
      storageDriver: process.env.INTEGRATIONS_STORAGE_DRIVER ?? 'mongo',
    },
    '[integrations] module ready'
  );
}

export * from './types.js';
export { providerRegistry } from './ProviderRegistry.js';
export { OAuthService } from './OAuthService.js';
export type { IntegrationStore } from './store/IntegrationStore.js';
export type { CredentialsStore } from './store/CredentialsStore.js';
