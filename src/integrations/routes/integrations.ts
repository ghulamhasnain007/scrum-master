import type { FastifyInstance, FastifyRequest } from 'fastify';
import { providerRegistry } from '../ProviderRegistry.js';
import type { OAuthService } from '../OAuthService.js';
import type { IntegrationStore } from '../store/IntegrationStore.js';
import type { CredentialsStore } from '../store/CredentialsStore.js';
import { getIntegrationBaseUrl } from '../utils/getIntegrationBaseUrl.js';

// This app runs as a single organization/workspace (matching the rest of
// the app's "one shared room" simplification) — there's no per-user login
// to derive a real orgId/userId from. To extend this to true multi-tenant
// later: derive ORG_ID from an authenticated session instead of this
// constant, and everything else (routes, stores) already takes orgId as a
// parameter, so no other changes would be needed.
const ORG_ID = 'default';

export default function registerIntegrationRoutes(
  fastify: FastifyInstance,
  deps: { oauth: OAuthService; store: IntegrationStore; credentialsStore: CredentialsStore }
): void {
  const { oauth, store, credentialsStore } = deps;

  // ── List providers: schema + configuration + connection status ─────────────
  fastify.get('/integrations/providers', async () => {
    const connections = await store.listConnections(ORG_ID);

    return Promise.all(providerRegistry.list().map(async (factory) => {
      const conn = connections.find((c) => c.provider === factory.id);
      const configured = await credentialsStore.isConfigured(ORG_ID, factory.id);
      return {
        id: factory.id,
        displayName: factory.displayName,
        capabilities: factory.capabilities,
        docsUrl: factory.docsUrl,
        notes: factory.notes,
        requiresAdvancedSetup: factory.requiresAdvancedSetup ?? false,
        credentialFields: factory.credentialFields,
        configured,
        status: conn?.status ?? 'disconnected',
        enabled: conn?.enabled ?? false,
        connectedAt: conn?.connectedAt ?? null,
        lastError: conn?.lastError ?? null,
      };
    }));
  });

  // ── Save app credentials (Client ID/Secret/etc) for a provider ──────────────
  fastify.post('/integrations/:provider/credentials', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    const factory = providerRegistry.getFactory(provider);
    const body = (req.body ?? {}) as Record<string, string>;

    const missing = factory.credentialFields.filter((f) => f.required && !body[f.key]?.trim());
    if (missing.length) {
      return reply.code(400).send({ error: `Missing required field(s): ${missing.map((f) => f.label).join(', ')}` });
    }

    await credentialsStore.save(ORG_ID, provider, body);
    return { provider, configured: true };
  });

  // ── Read back saved credentials (non-secret fields only) ────────────────────
  fastify.get('/integrations/:provider/credentials', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    const factory = providerRegistry.getFactory(provider);
    const creds = await credentialsStore.get(ORG_ID, provider);
    if (!creds) return { configured: false, values: {} };

    // Secret fields are never echoed back once saved — the settings form
    // shows them as already-set placeholders instead of the real value.
    const values: Record<string, string> = {};
    for (const field of factory.credentialFields) {
      if (!field.secret) values[field.key] = creds[field.key] ?? '';
    }
    const secretsSet = factory.credentialFields.filter((f) => f.secret).map((f) => f.key);
    return { configured: true, values, secretsSet };
  });

  // ── Clear saved credentials (also drops any live connection) ────────────────
  fastify.delete('/integrations/:provider/credentials', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    await credentialsStore.delete(ORG_ID, provider);
    await store.deleteConnection(ORG_ID, provider);
    return { provider, configured: false };
  });

  // ── Start OAuth connect flow ────────────────────────────────────────────────
  fastify.get('/integrations/:provider/connect', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    try {
      const baseUrl = getIntegrationBaseUrl(req);
      const url = await oauth.startConnect(provider, ORG_ID, baseUrl);
      return reply.redirect(url);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to start OAuth flow' });
    }
  });

  // ── OAuth callback — redirects back into the app's UI either way ────────────
  fastify.get('/integrations/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) return reply.redirect(`${process.env.CORS_ORIGIN}/?integration=${provider}&status=error&message=${encodeURIComponent(error)}`);
    if (!code || !state) return reply.code(400).send({ error: 'Missing code or state' });

    try {
      const baseUrl = getIntegrationBaseUrl(req);
      const { redirectTo } = await oauth.handleCallback(baseUrl, provider, code, state);
      return reply.redirect(redirectTo);
    } catch (err) {
      const message = encodeURIComponent(err instanceof Error ? err.message : 'OAuth callback failed');
      return reply.redirect(`${process.env.CORS_ORIGIN}/?integration=${provider}&status=error&message=${message}`);
    }
  });

  // ── Toggle enabled/disabled without disconnecting ────────────────────────────
  fastify.post('/integrations/:provider/toggle', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { enabled } = (req.body ?? {}) as { enabled: boolean };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    await store.setEnabled(ORG_ID, provider, enabled);
    return { provider, enabled };
  });

  // ── Disconnect (revoke + delete stored tokens, keeps saved credentials) ─────
  fastify.delete('/integrations/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    await oauth.disconnect(ORG_ID, provider);
    return { provider, disconnected: true };
  });

  // ── Provider webhooks — signature-verified per adapter ───────────────────────
  fastify.post('/integrations/:provider/webhook', { config: { rawBody: true } }, async (req: FastifyRequest, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerRegistry.has(provider)) return reply.code(404).send({ error: `Unknown provider: ${provider}` });

    const credentials = await credentialsStore.get(ORG_ID, provider);
    if (!credentials) return reply.code(400).send({ error: `${provider} is not configured` });

    const adapter = providerRegistry.buildAdapter(provider, credentials);
    const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;

    // Some providers (Zoom) require answering a one-time handshake before
    // any signature can be verified.
    if (adapter.handleUrlValidation) {
      const validation = adapter.handleUrlValidation(rawBody);
      if (validation) return reply.send(validation);
    }

    if (!adapter.verifyWebhook(req.headers, rawBody)) {
      return reply.code(401).send({ error: 'Webhook signature verification failed' });
    }

    const events = adapter.parseWebhookEvent(rawBody);
    for (const event of events) {
      // Hand off to whatever the existing app uses to consume normalized
      // meeting events — out of scope here — e.g.: meetingEventBus.emit(event);
      fastify.log.info({ event }, `[integrations:${provider}] event`);
    }

    return reply.code(200).send({ received: events.length });
  });
}
