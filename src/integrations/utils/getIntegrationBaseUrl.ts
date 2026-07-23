import type { FastifyRequest } from 'fastify';

export function getIntegrationBaseUrl(request: FastifyRequest): string {
  // Local / QA
  if (process.env.ENVIRONMENT !== 'production') {
    return (
      process.env.INTEGRATIONS_BASE_URL ??
      `http://localhost:${process.env.PORT ?? 3001}/integrations`
    );
  }

  const protocol =
    (request.headers['x-forwarded-proto'] as string) ??
    request.protocol;

  const host =
    (request.headers['x-forwarded-host'] as string) ??
    request.headers.host;

  return `${protocol}://${host}/integrations`;
}