export type AppScreenId = 'connect' | 'watch' | 'room' | 'transfers' | 'chat' | 'settings';

export type AppScreen = {
  id: AppScreenId;
  title: string;
};

export const APP_SCREENS: AppScreen[] = [
  { id: 'connect', title: 'Connection' },
  { id: 'watch', title: 'Watch' },
  { id: 'room', title: 'Room' },
  { id: 'transfers', title: 'Transfers' },
  { id: 'chat', title: 'Chat' },
  { id: 'settings', title: 'Options' }
];

export function getInitialScreen(connected: boolean): AppScreenId {
  return connected ? 'watch' : 'connect';
}

export function getScreenTitle(screenId: AppScreenId): string {
  return APP_SCREENS.find(screen => screen.id === screenId)?.title ?? 'Syncplay';
}
