import type { Client } from 'discord.js';
import { DiscordMeetingRoom } from './DiscordMeetingRoom.js';

/** One active meeting per Discord server (guild) at a time — a server
 *  running two standups in different voice channels simultaneously is an
 *  edge case we intentionally don't support yet. */
const activeRooms = new Map<string, DiscordMeetingRoom>();

export async function startDiscordMeeting(
  client: Client,
  guildId: string,
  channelId: string,
  durationMs?: number
): Promise<DiscordMeetingRoom> {
  if (activeRooms.has(guildId)) {
    throw new Error('A standup is already running in this server — stop it before starting another.');
  }
  const room = new DiscordMeetingRoom(client, guildId, channelId, () => activeRooms.delete(guildId));
  await room.start(durationMs); // throws (and never gets registered) if joining/starting fails
  activeRooms.set(guildId, room);
  return room;
}

export async function stopDiscordMeeting(guildId: string): Promise<void> {
  const room = activeRooms.get(guildId);
  if (!room) return;
  try {
    await room.stop(); // also calls onEnded() -> activeRooms.delete(guildId)
  } finally {
    // Belt-and-suspenders: guarantee the guild is never left stuck as
    // "active" even if stop() throws before reaching onEnded().
    activeRooms.delete(guildId);
  }
}

export function getDiscordMeeting(guildId: string): DiscordMeetingRoom | undefined {
  return activeRooms.get(guildId);
}

/** Every guild currently running a meeting — lets the UI discover and show
 *  a Stop button for meetings it didn't itself start (e.g. launched by a
 *  schedule), instead of only tracking ones started from this browser tab. */
export function listActiveDiscordMeetings(): string[] {
  return [...activeRooms.keys()];
}
