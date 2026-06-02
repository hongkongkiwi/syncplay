import type { MediaLibraryItem } from '../syncplay/mediaLibrary';

type PrivacyMode = 'full' | 'hashed' | 'none';

export const PREFERENCES_STORAGE_KEY = 'syncplay-mobile/preferences/v1';

export type LoopMode = 'none' | 'single' | 'playlist';

export type PersistedConnectionForm = {
  serverAddress: string;
  username: string;
  room: string;
  password: string;
  useTls: boolean;
};

export type PersistedPreferences = {
  version: 1;
  form: PersistedConnectionForm;
  savedRooms: string[];
  mediaLibrary: MediaLibraryItem[];
  controlPasswords: Record<string, string>;
  autosaveJoinedRooms: boolean;
  hideEmptyRooms: boolean;
  syncPaused: boolean;
  autoReconnect: boolean;
  autoFileSwitch: boolean;
  keepPlayingInBackground: boolean;
  privacyMode: PrivacyMode;
  autoPlayEnabled: boolean;
  autoPlayThreshold: number;
  timeOffset: number;
  loopMode: LoopMode;
};

export function createPersistedPreferences(
  preferences: Omit<PersistedPreferences, 'version'>
): PersistedPreferences {
  return {
    version: 1,
    ...preferences,
    form: scrubSensitiveFormFields(preferences.form)
  };
}

export function serializePersistedPreferences(preferences: PersistedPreferences): string {
  return JSON.stringify(preferences);
}

export function parsePersistedPreferences(value: string | null): PersistedPreferences | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PersistedPreferences>;
    if (parsed.version !== 1 || !isForm(parsed.form)) {
      return null;
    }

    return {
      version: 1,
      form: scrubSensitiveFormFields(parsed.form),
      savedRooms: Array.isArray(parsed.savedRooms) ? parsed.savedRooms.filter(isString) : [],
      mediaLibrary: Array.isArray(parsed.mediaLibrary)
        ? parsed.mediaLibrary.filter(isMediaLibraryItem)
        : [],
      controlPasswords: isRecord(parsed.controlPasswords) ? parsed.controlPasswords : {},
      autosaveJoinedRooms: parsed.autosaveJoinedRooms !== false,
      hideEmptyRooms: parsed.hideEmptyRooms === true,
      syncPaused: parsed.syncPaused === true,
      autoReconnect: parsed.autoReconnect !== false,
      autoFileSwitch: parsed.autoFileSwitch !== false,
      keepPlayingInBackground: parsed.keepPlayingInBackground === true,
      privacyMode: isPrivacyMode(parsed.privacyMode) ? parsed.privacyMode : 'full',
      autoPlayEnabled: parsed.autoPlayEnabled === true,
      autoPlayThreshold: typeof parsed.autoPlayThreshold === 'number' && parsed.autoPlayThreshold >= 2 ? parsed.autoPlayThreshold : 2,
      timeOffset: typeof parsed.timeOffset === 'number' ? parsed.timeOffset : 0,
      loopMode: isLoopMode(parsed.loopMode) ? parsed.loopMode : 'none'
    };
  } catch {
    return null;
  }
}

function scrubSensitiveFormFields(form: PersistedConnectionForm): PersistedConnectionForm {
  return {
    ...form,
    password: ''
  };
}

function isForm(value: unknown): value is PersistedConnectionForm {
  const form = value as PersistedConnectionForm | undefined;
  return (
    !!form &&
    typeof form.serverAddress === 'string' &&
    typeof form.username === 'string' &&
    typeof form.room === 'string' &&
    typeof form.password === 'string' &&
    typeof form.useTls === 'boolean'
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isMediaLibraryItem(value: unknown): value is MediaLibraryItem {
  const item = value as MediaLibraryItem | undefined;
  return (
    !!item &&
    typeof item.name === 'string' &&
    typeof item.uri === 'string' &&
    typeof item.size === 'number' &&
    (typeof item.duration === 'number' || item.duration === null) &&
    (typeof item.directory === 'string' || item.directory === null)
  );
}

function isRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).every(item => typeof item === 'string')
  );
}

function isPrivacyMode(value: unknown): value is PrivacyMode {
  return value === 'full' || value === 'hashed' || value === 'none';
}

function isLoopMode(value: unknown): value is LoopMode {
  return value === 'none' || value === 'single' || value === 'playlist';
}
