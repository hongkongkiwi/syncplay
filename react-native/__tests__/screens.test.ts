import { APP_SCREENS, getInitialScreen, getScreenTitle } from '../src/navigation/screens';

describe('mobile screen registry', () => {
  it('covers the main Syncplay workflows', () => {
    expect(APP_SCREENS.map(screen => screen.id)).toEqual([
      'connect',
      'watch',
      'room',
      'transfers',
      'chat',
      'settings'
    ]);
  });

  it('starts on connect until the user has an active session', () => {
    expect(getInitialScreen(false)).toBe('connect');
    expect(getInitialScreen(true)).toBe('watch');
  });

  it('has user-facing titles for each screen', () => {
    expect(getScreenTitle('connect')).toBe('Connection');
    expect(getScreenTitle('watch')).toBe('Watch');
    expect(getScreenTitle('room')).toBe('Room');
    expect(getScreenTitle('transfers')).toBe('Transfers');
    expect(getScreenTitle('chat')).toBe('Chat');
    expect(getScreenTitle('settings')).toBe('Options');
  });
});
