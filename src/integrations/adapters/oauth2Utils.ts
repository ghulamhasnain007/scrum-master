/**
 * Shared low-level OAuth2 (RFC 6749 authorization-code grant) helpers.
 * Zoom, Google, Microsoft, and Discord all speak standard OAuth2 token
 * endpoints, so every adapter reuses these instead of reimplementing
 * request/response handling four times.
 */

export interface OAuth2Endpoints {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

async function postForm(url: string, body: URLSearchParams): Promise<RawTokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth request to ${url} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<RawTokenResponse>;
}

export async function exchangeAuthorizationCode(
  endpoints: OAuth2Endpoints,
  params: { code: string; redirectUri: string; extra?: Record<string, string> }
): Promise<RawTokenResponse> {
  return postForm(endpoints.tokenUrl, new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: endpoints.clientId,
    client_secret: endpoints.clientSecret,
    ...params.extra,
  }));
}

export async function refreshAccessToken(
  endpoints: OAuth2Endpoints,
  refreshToken: string
): Promise<RawTokenResponse> {
  return postForm(endpoints.tokenUrl, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: endpoints.clientId,
    client_secret: endpoints.clientSecret,
  }));
}

export function toTokenSet(raw: RawTokenResponse) {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : null,
    scope: raw.scope,
    raw,
  };
}
