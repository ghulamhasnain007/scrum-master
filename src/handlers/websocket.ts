import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { MeetingSession } from '../services/MeetingSession.js';
import type { ClientMessage, ServerMessage } from '../types/index.js';
import { config } from '../config/index.js';

// A single shared meeting room for the whole backend process — every
// connected client participates in the same Daily Scrum, like everyone
// dialing into one call. (To support multiple concurrent standups, swap
// this for a Map<roomId, MeetingSession> keyed off a room id sent in the
// `join` message instead of this module-level singleton.)
const room = new MeetingSession();

export default function registerWebSocket(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket) => {
    console.log('[WS] Client connected');
    let participantId: string | null = null;

    const send = (msg: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    socket.on('message', async (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send({ type: 'error', message: 'Invalid JSON message' });
        return;
      }

      // Every connection must join with a display name before anything else.
      if (msg.type === 'join') {
        if (participantId) return; // already joined, ignore repeats
        const participant = room.join(msg.name, send);
        participantId = participant.id;
        console.log(`[WS] ${participant.name} joined (${participant.id}${participant.isHost ? ', host' : ''})`);
        return;
      }

      if (!participantId) {
        send({ type: 'error', message: 'Send a "join" message with your name first.' });
        return;
      }

      switch (msg.type) {
        case 'start_meeting': {
          const duration = msg.durationMs ?? config.defaultMeetingDurationMs;
          console.log(`[WS] Starting meeting — ${duration / 60000} min`);
          await room.startMeeting(participantId, duration);
          break;
        }
        case 'end_meeting':
          console.log('[WS] End meeting requested');
          await room.endMeeting();
          break;

        case 'audio_chunk':
          room.handleAudioChunk(participantId, msg.chunk);
          break;

        case 'audio_stream_end':
          room.handleAudioStreamEnd(participantId);
          break;

        case 'ping':
          send({ type: 'meeting_state', state: room.getState() });
          break;

        default:
          console.warn('[WS] Unknown message type:', (msg as { type: string }).type);
      }
    });

    socket.on('close', () => {
      console.log('[WS] Client disconnected');
      if (participantId) room.leave(participantId);
    });

    socket.on('error', (err: Error) => {
      console.error('[WS] Socket error:', err.message);
    });
  });
}
