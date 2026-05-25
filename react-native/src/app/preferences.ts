import type { MediaLibraryItem } from '../syncplay/mediaLibrary';

export const PREFERENCES_STORAGE_KEY = 'syncplay-mobile/preferences/v1';

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
      keepPlayingInBackground: parsed.keepPlayingInBackground === true
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
