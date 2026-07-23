import { ZoomAdapter } from './ZoomAdapter.js';
import { GoogleMeetAdapter } from './GoogleMeetAdapter.js';
import { TeamsAdapter } from './TeamsAdapter.js';
import { DiscordAdapter } from './DiscordAdapter.js';
import type { ProviderFactory } from '../types.js';

/**
 * One factory per provider: static metadata + the exact fields an org admin
 * needs to fill in on the Integrations settings screen + a function that
 * turns those saved values into a live adapter. This file is the only place
 * that needs a new entry when a new meeting platform is added — everything
 * downstream (storage, routes, the settings UI) reads it generically.
 */

export const zoomFactory: ProviderFactory = {
  id: 'zoom',
  displayName: 'Zoom',
  capabilities: ['oauth_connect', 'webhook_events', 'realtime_audio', 'transcript_fetch'],
  docsUrl: 'https://developers.zoom.us/docs/rtms/',
  notes:
    'Real-time audio uses Zoom Realtime Media Streams (RTMS), a paid Developer Pack feature. No bot joins ' +
    'the meeting — the host enables the RTMS app and Zoom streams audio/transcript directly over WebSocket.',
  credentialFields: [
    { key: 'clientId', label: 'Client ID', secret: false, required: true },
    { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    {
      key: 'webhookSecretToken',
      label: 'Webhook Secret Token',
      secret: true,
      required: true,
      helpText: 'From your Zoom Marketplace app → Feature → Event Subscriptions.',
    },
  ],
  create: (c) => new ZoomAdapter({
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    webhookSecretToken: c.webhookSecretToken,
  }),
};

export const googleMeetFactory: ProviderFactory = {
  id: 'google_meet',
  displayName: 'Google Meet',
  capabilities: ['oauth_connect', 'transcript_fetch', 'webhook_events'],
  docsUrl: 'https://developers.google.com/workspace/meet/api/guides/overview',
  requiresAdvancedSetup: true,
  notes:
    'Transcript access uses the Workspace Meet REST API (post-meeting, requires a Workspace edition with Meet ' +
    'transcription enabled). Real-time audio requires the allowlisted Meet Media API and is not implemented.',
  credentialFields: [
    { key: 'clientId', label: 'OAuth Client ID', secret: false, required: true },
    { key: 'clientSecret', label: 'OAuth Client Secret', secret: true, required: true },
  ],
  create: (c) => new GoogleMeetAdapter({ clientId: c.clientId, clientSecret: c.clientSecret }),
};

export const teamsFactory: ProviderFactory = {
  id: 'microsoft_teams',
  displayName: 'Microsoft Teams',
  capabilities: ['oauth_connect', 'transcript_fetch', 'webhook_events'],
  docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onlinemeeting',
  requiresAdvancedSetup: true,
  notes:
    'Transcript access uses Microsoft Graph onlineMeetings transcripts (post-meeting). Real-time audio requires ' +
    'a calling bot on the .NET-only Graph Communications Calls.Media SDK — out of scope for this module.',
  credentialFields: [
    { key: 'clientId', label: 'Application (client) ID', secret: false, required: true },
    { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    {
      key: 'tenantId',
      label: 'Tenant ID',
      secret: false,
      required: false,
      placeholder: 'common',
      helpText: 'Leave blank (defaults to "common") for a multi-tenant app registration.',
    },
    {
      key: 'webhookClientState',
      label: 'Webhook Client State',
      secret: true,
      required: true,
      helpText: 'A secret string you choose — set it as clientState when creating the Graph subscription.',
    },
  ],
  create: (c) => new TeamsAdapter({
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    tenantId: c.tenantId?.trim() || 'common',
    webhookClientState: c.webhookClientState,
  }),
};

export const discordFactory: ProviderFactory = {
  id: 'discord',
  displayName: 'Discord',
  capabilities: ['oauth_connect', 'webhook_events', 'realtime_audio', 'bot_join'],
  docsUrl: 'https://discord.com/developers/docs/topics/voice-connections',
  notes:
    'The bot joins a voice channel directly and streams Opus audio both ways via the Discord voice gateway — ' +
    'the most natively supported real-time path of the four providers.',
  credentialFields: [
    { key: 'clientId', label: 'Application ID', secret: false, required: true },
    { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    { key: 'botToken', label: 'Bot Token', secret: true, required: true },
    { key: 'publicKey', label: 'Public Key', secret: false, required: true, helpText: 'From General Information in the Developer Portal.' },
  ],
  create: (c) => new DiscordAdapter({
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    botToken: c.botToken,
    publicKey: c.publicKey,
  }),
};

export const allProviderFactories: ProviderFactory[] = [
  zoomFactory, googleMeetFactory, teamsFactory, discordFactory,
];
