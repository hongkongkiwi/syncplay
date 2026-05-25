import { normalizeManagedRoomPassword } from './managedRooms';

export type ParsedRoomEntry = {
  room: string;
  password: string | null;
  listValue: string;
};

export function parseRoomEntry(entry: string): ParsedRoomEntry {
  const cleaned = entry.trim();
  const parts = cleaned.split(':');

  if (cleaned.startsWith('+') && parts.length > 2) {
    const room = `${parts[0]}:${parts[1]}`;
    const password = normalizeManagedRoomPassword(parts[2] ?? '');
    return {
      room,
      password,
      listValue: password ? `${room}:${password}` : room
    };
  }

  return {
    room: cleaned,
    password: null,
    listValue: cleaned
  };
}

export function resolveJoinRoomEntry(entry: string, mediaName: string | null, defaultRoom: string): string {
  const cleaned = entry.trim();
  if (cleaned) {
    return cleaned;
  }

  return mediaName?.trim() || defaultRoom;
}

export function addRoomToSavedList(savedRooms: string[], room: string): string[] {
  const cleaned = room.trim();
  if (!cleaned) {
    return [...savedRooms].sort(compareRoomNames);
  }

  return Array.from(new Set([...savedRooms, cleaned])).sort(compareRoomNames);
}

export function buildRoomOptions(savedRooms: string[], currentRooms: string[]): string[] {
  return [
    ...savedRooms,
    ...currentRooms.filter(room => !savedRooms.includes(room))
  ];
}

export function filterVisibleRooms(
  rooms: Record<string, unknown[]>,
  hideEmptyRooms: boolean
): string[] {
  return Object.entries(rooms)
    .filter(([, users]) => !hideEmptyRooms || users.length > 0)
    .map(([room]) => room)
    .sort(compareRoomNames);
}

function compareRoomNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}
