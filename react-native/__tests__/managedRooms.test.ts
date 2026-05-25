import {
  generateManagedRoomPassword,
  normalizeManagedRoomPassword
} from '../src/syncplay/managedRooms';

describe('managed room helpers', () => {
  it('normalizes operator passwords like the desktop app', () => {
    expect(normalizeManagedRoomPassword('ab-123-456')).toBe('AB-123-456');
    expect(normalizeManagedRoomPassword('ab 123 456')).toBe('AB123456');
  });

  it('generates desktop-shaped operator passwords', () => {
    expect(generateManagedRoomPassword()).toMatch(/^[A-Z]{2}-\d{3}-\d{3}$/);
  });
});
