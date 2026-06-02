import { useEvent, useEventListener } from 'expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { Directory } from 'expo-file-system';
import { VideoView, useVideoPlayer } from 'expo-video';
import {
  Check,
  Clock,
  DoorOpen,
  Download,
  Film,
  FolderOpen,
  Globe,
  HelpCircle,
  KeyRound,
  Library,
  Link,
  ListPlus,
  MessageCircle,
  MonitorPlay,
  Moon,
  Pause,
  Play,
  Plug,
  Send,
  Settings as SettingsIcon,
  Shuffle,
  Sun,
  Trash2,
  Undo2,
  Users
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

import {
  P2PConnection,
  AVATAR_PRESETS,
  STATUS_PRESETS,
  type ConnectionState,
  type P2PConnectionConfig,
  type FileEntry,
  type PeerState,
  type RoomStateSnapshot,
  type SyncEvent,
  type SubtitleTrack,
} from './src/syncplay/connectionV2';
import VoiceChat from './src/syncplay/voiceChat';
import { scanMediaDirectory } from './src/app/directoryScanner';
import { resolvePlaylistItem } from './src/app/playlistPlayback';
import { calculateSyncCorrection } from './src/app/syncControl';
import { ErrorBoundary } from './src/app/ErrorBoundary';
import {
  APP_SCREENS,
  getInitialScreen,
  getScreenTitle,
  type AppScreenId
} from './src/navigation/screens';

// ── Types ──────────────────────────────────────────────────────────────────

type SyncplayFile = {
  name: string;
  duration: number;
  size: number;
};

// ── Local helpers (inlined from deleted v1 files) ─────────────────────

// -- Media library types --
type MediaLibraryItem = { name: string; uri: string; size: number; duration: number | null; directory: string | null };
type IncomingMediaLibraryItem = { name?: string | null; uri: string; size?: number | null; duration?: number | null; directory?: string | null };

// -- Helper functions for media library --
function stripQueryAndHash(path: string): string { return path.split(/[?#]/, 1)[0] ?? path; }
function decodePathPart(part: string): string { try { return decodeURIComponent(part); } catch { return part; } }

function getFilenameFromPath(path: string | null | undefined): string {
  if (!path) return '';
  const cleanPath = stripQueryAndHash(path);
  const parts = cleanPath.split(/[\\/]/).filter(Boolean);
  const filename = parts.at(-1) ?? cleanPath;
  return decodePathPart(filename);
}

function normalizeFilename(filename: string | null | undefined): string {
  return getFilenameFromPath(filename).trim().toLocaleLowerCase();
}

function getDirectoryLabel(uri: string): string | null {
  const cleanUri = stripQueryAndHash(uri);
  const parts = cleanUri.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  const directory = parts[parts.length - 2];
  return directory ? decodePathPart(directory) || null : null;
}

function normalizeMediaItem(item: IncomingMediaLibraryItem): MediaLibraryItem {
  const name = item.name?.trim() || getFilenameFromPath(item.uri) || 'video';
  return { name, uri: item.uri, size: item.size ?? 0, duration: item.duration ?? null, directory: item.directory?.trim() || getDirectoryLabel(item.uri) };
}

// -- Media library functions --
function addMediaItems(existingItems: MediaLibraryItem[], incomingItems: IncomingMediaLibraryItem[]): MediaLibraryItem[] {
  const itemsByUri = new Map(existingItems.map(item => [item.uri, item]));
  for (const incomingItem of incomingItems) {
    if (!incomingItem.uri || itemsByUri.has(incomingItem.uri)) continue;
    itemsByUri.set(incomingItem.uri, normalizeMediaItem(incomingItem));
  }
  return Array.from(itemsByUri.values());
}

function findMediaByName(items: MediaLibraryItem[], filename: string | null | undefined): MediaLibraryItem | null {
  const target = normalizeFilename(filename);
  if (!target) return null;
  return items.find(item => normalizeFilename(item.name) === target) ?? null;
}

function buildDirectoryLabels(items: MediaLibraryItem[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of items) {
    if (!item.directory || seen.has(item.directory)) continue;
    seen.add(item.directory);
    labels.push(item.directory);
  }
  return labels;
}

// -- File picker helpers --
function assetToMediaLibraryItem(asset: { uri: string; name: string; size?: number }): IncomingMediaLibraryItem {
  return { name: asset.name, uri: asset.uri, size: asset.size ?? 0, duration: null, directory: null };
}

// -- Formatting helpers --
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'unknown size';
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
}

// -- Timestamp parsing --
function parseTimestamp(value: string): number | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  const parts = cleaned.split(':');
  if (parts.some(part => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(part => Number.parseInt(part, 10));
  if (numbers.some(number => !Number.isFinite(number))) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

// -- Slash command parser --
type SlashCommandResult =
  | { kind: 'chat'; text: string }
  | { kind: 'me'; action: string }
  | { kind: 'nick'; username: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'help'; commands: string };

function parseSlashCommand(input: string, username: string): SlashCommandResult | null {
  const trimmed = input.trim();
  if (trimmed === '/help') {
    const commands = [
      '/help — Show this help',
      '/me <action> — Send an action message',
      '/nick <username> — Change your username',
      '/topic <text> — Set room topic'
    ].join('\n');
    return { kind: 'help', commands };
  }
  if (trimmed.startsWith('/me ')) {
    const action = trimmed.slice(4).trim();
    if (!action) return null;
    return { kind: 'me', action };
  }
  if (trimmed.startsWith('/nick ')) {
    const newUsername = trimmed.slice(6).trim();
    if (!newUsername) return null;
    return { kind: 'nick', username: newUsername };
  }
  if (trimmed.startsWith('/topic ')) {
    const topic = trimmed.slice(7).trim();
    if (!topic) return null;
    return { kind: 'topic', topic };
  }
  if (trimmed.startsWith('/')) return { kind: 'chat', text: trimmed };
  return null;
}

// -- Shuffle --
function shuffleFiles(files: string[], random = Math.random): string[] {
  const shuffled = [...files];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) continue;
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

// -- Preferences types and storage key --
type LoopMode = 'none' | 'single' | 'playlist';
const PREFERENCES_STORAGE_KEY = 'syncplay-mobile/preferences/v2';

interface PersistedPreferences {
  form: { serverAddress?: string; username?: string; room?: string; password?: string };
  savedRooms: string[];
  mediaLibrary: MediaLibraryItem[];
  controlPasswords: Record<string, string>;
  autosaveJoinedRooms: boolean;
  hideEmptyRooms: boolean;
  syncPaused: boolean;
  autoReconnect: boolean;
  autoFileSwitch: boolean;
  keepPlayingInBackground: boolean;
  privacyMode: string;
  autoPlayEnabled: boolean;
  autoPlayThreshold: number;
  timeOffset: number;
  loopMode: LoopMode;
}

function createPersistedPreferences(p: PersistedPreferences): PersistedPreferences {
  return { ...p, form: { ...p.form } };
}

function parsePersistedPreferences(value: string | null): PersistedPreferences | null {
  if (!value) return null;
  try { return JSON.parse(value) as PersistedPreferences; }
  catch { return null; }
}

function serializePersistedPreferences(p: PersistedPreferences): string {
  return JSON.stringify(p);
}

type ConnectionForm = {
  host: string;
  username: string;
  room: string;
  password: string;
  turnUrl: string;
};
type ConnectionTextField = Exclude<keyof ConnectionForm, never>;

type ChatMessage = {
  id: string;
  text: string;
  username?: string;
  kind?: string;
  createdAt: number;
};

const defaultForm: ConnectionForm = {
  host: 'syncplay.pl',
  username: 'Mobile',
  room: 'default',
  password: '',
  turnUrl: ''
};

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${++messageIdCounter}-${Date.now()}`;
}

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case 'offline': return 'Disconnected';
    case 'connecting': return 'Connecting…';
    case 'handshaking': return 'Handshaking…';
    case 'connecting_peers': return 'Connecting peers…';
    case 'ready': return 'Connected';
    case 'reconnecting': return 'Reconnecting…';
    case 'error': return 'Error';
    default: return 'Unknown';
  }
}

// ── Avatar / Status helpers ────────────────────────────────────────────────

function getAvatarEmoji(presetId: string | undefined): string | null {
  if (!presetId) return null;
  return AVATAR_PRESETS.find(preset => preset.id === presetId)?.emoji ?? null;
}

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Room state (synced from P2P)
  const [playstate, setPlaystate] = useState<{ position: number; paused: boolean; setBy: string; speed: number; doSeek: boolean }>({
    position: 0, paused: true, setBy: '', speed: 1.0, doSeek: false,
  });
  const [playlist, setPlaylist] = useState<{ files: string[]; index: number }>({ files: [], index: 0 });
  const [roomPeers, setRoomPeers] = useState<PeerState[]>([]);

  // Chat messages
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Transfer progress
  const [transferProgress, setTransferProgress] = useState<Array<{transferId:string, filename:string, progress:number, sentBytes:number, totalSize:number}>>([]);

  // Form & local UI
  const [form, setForm] = useState(defaultForm);
  const [chatDraft, setChatDraft] = useState('');
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [media, setMedia] = useState<SyncplayFile | null>(null);
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibraryItem[]>([]);
  const [streamUrl, setStreamUrl] = useState('');
  const [seekDraft, setSeekDraft] = useState('0:00');
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [autoFileSwitch, setAutoFileSwitch] = useState(true);
  const [keepPlayingInBackground, setKeepPlayingInBackground] = useState(true);
  const [timeOffset, setTimeOffset] = useState(0);
  const [loopMode, setLoopMode] = useState<LoopMode>('none');
  const [missingMediaName, setMissingMediaName] = useState<string | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [activeScreen, setActiveScreen] = useState<AppScreenId>(getInitialScreen(false));
  const [savedRooms, setSavedRooms] = useState<string[]>(['default']);
  const [roomListDraft, setRoomListDraft] = useState('default');
  const [autosaveJoinedRooms, setAutosaveJoinedRooms] = useState(true);
  const [hideEmptyRooms, setHideEmptyRooms] = useState(false);
  const [darkMode, setDarkMode] = useState(true); // default dark
  const [showHelp, setShowHelp] = useState(false);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
  const [selectedStatusText, setSelectedStatusText] = useState<string | null>(null);

  // Refs
  const lastSentPositionRef = useRef(0);
  const previousSeekPositionRef = useRef<number | null>(null);
  const lastConnectionConfigRef = useRef<P2PConnectionConfig | null>(null);
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedPlaylistKeyRef = useRef<string | null>(null);
  const voiceChatRef = useRef<VoiceChat | null>(null);
  const lastAutoFileSwitchRef = useRef<string | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const usernameRef = useRef(form.username);

  const player = useVideoPlayer(mediaUri, instance => {
    instance.timeUpdateEventInterval = 0.5;
    instance.showNowPlayingNotification = true;
    instance.staysActiveInBackground = keepPlayingInBackground;
  });

  const playingEvent = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const timeEvent = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0
  });
  const statusEvent = useEvent(player, 'statusChange', { status: player.status });

  const handleSyncEventRef = useRef(handleSyncEvent);

  const connection = useMemo(() => {
    const conn = new P2PConnection(form.username);
    // Subscribe to state manager events
    conn.stateManager.onSyncEvent((event: SyncEvent) => {
      handleSyncEventRef.current(event, conn);
    });
    return conn;
  }, []);

  handleSyncEventRef.current = handleSyncEvent;

  // Keep username ref in sync
  useEffect(() => {
    usernameRef.current = form.username;
  }, [form.username]);

  // ── VoiceChat ────────────────────────────────────────────────────────────

  useEffect(() => {
    // Create VoiceChat once connection exists
    if (!voiceChatRef.current) {
      voiceChatRef.current = new VoiceChat(connection.stateManager);
    }
    return () => {
      // Destroy on unmount
      voiceChatRef.current?.destroy();
      voiceChatRef.current = null;
    };
  }, [connection]);

  // Auto-start voice capture when connected and not muted
  useEffect(() => {
    if (connectionState === 'ready' && !voiceMuted) {
      voiceChatRef.current?.startCapture().catch(() => {});
    }
  }, [connectionState, voiceMuted]);

  // ── SyncEvent handler ───────────────────────────────────────────────────

  function handleSyncEvent(event: SyncEvent, conn: P2PConnection) {
    switch (event.type) {
      case 'chat': {
        const data = event.data as { from: string; message: string; timestamp: number };
        if (data.from === usernameRef.current) break;
        setMessages(prev => [...prev, {
          id: nextMessageId(),
          text: data.message,
          username: data.from,
          kind: 'chat',
          createdAt: data.timestamp || Date.now(),
        }].slice(-500));
        break;
      }
      case 'playstate': {
        const snapshot = event.data as RoomStateSnapshot;
        setPlaystate({
          position: snapshot.position,
          paused: snapshot.paused,
          setBy: snapshot.setBy,
          speed: snapshot.speed,
          doSeek: snapshot.doSeek,
        });
        setPlaylist({
          files: snapshot.playlist.map(f => f.name),
          index: snapshot.playlistIndex,
        });
        setRoomPeers(Object.values(snapshot.peers));
        // Update readiness from snapshot
        const myReady = snapshot.readyStates[usernameRef.current] ?? false;
        setIsReady(myReady);
        break;
      }
      case 'user-join': {
        refreshPeers(conn);
        break;
      }
      case 'user-leave': {
        const leaveData = event.data as { username: string; reason: string };
        refreshPeers(conn);
        setMessages(prev => [...prev, {
          id: nextMessageId(),
          text: `${leaveData.username} left (${leaveData.reason})`,
          kind: 'system',
          createdAt: Date.now(),
        }].slice(-500));
        break;
      }
      case 'host-change': {
        refreshPeers(conn);
        break;
      }
      case 'transfer-progress': {
        const p = event.data as {transferId:string, filename:string, progress:number, sentBytes:number, totalSize:number};
        setTransferProgress(prev => {
          const existing = prev.find(t => t.transferId === p.transferId);
          if (existing) return prev.map(t => t.transferId === p.transferId ? p : t);
          return [...prev, p];
        });
        if (p.progress >= 1) {
          setTimeout(() => setTransferProgress(prev => prev.filter(t => t.transferId !== p.transferId)), 3000);
        }
        break;
      }
      case 'error': {
        setConnectionError(String(event.data ?? 'Unknown error'));
        break;
      }
    }
  }

  function refreshPeers(conn: P2PConnection) {
    const snap = conn.stateManager.getSnapshot();
    setRoomPeers(Object.values(snap.peers));
    setPlaylist({
      files: snap.playlist.map(f => f.name),
      index: snap.playlistIndex,
    });
  }

  // ── Preferences persistence ─────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(PREFERENCES_STORAGE_KEY)
      .then(value => {
        if (!alive) return;
        const preferences = parsePersistedPreferences(value);
        if (preferences) {
          // Map old serverAddress to new host field
          const mappedForm: ConnectionForm = {
            host: preferences.form.serverAddress?.split(':')[0] ?? 'syncplay.pl',
            username: preferences.form.username ?? 'Mobile',
            room: preferences.form.room ?? 'default',
            password: preferences.form.password ?? '',
            turnUrl: '',
          };
          setForm(mappedForm);
          setSavedRooms(preferences.savedRooms.length ? preferences.savedRooms : ['default']);
          setMediaLibrary(preferences.mediaLibrary);
          setAutosaveJoinedRooms(preferences.autosaveJoinedRooms);
          setHideEmptyRooms(preferences.hideEmptyRooms);
          setSyncPaused(preferences.syncPaused);
          setAutoReconnect(preferences.autoReconnect);
          setAutoFileSwitch(preferences.autoFileSwitch);
          setKeepPlayingInBackground(preferences.keepPlayingInBackground);
          setTimeOffset(preferences.timeOffset);
          setLoopMode(preferences.loopMode);
        }
      })
      .finally(() => {
        if (alive) setPreferencesLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  // Load dark mode preference
  useEffect(() => {
    AsyncStorage.getItem('syncplay-rn-theme')
      .then(value => {
        if (value !== null) {
          setDarkMode(value === 'dark');
        }
      })
      .catch(() => {});
  }, []);

  // Persist dark mode
  useEffect(() => {
    AsyncStorage.setItem('syncplay-rn-theme', darkMode ? 'dark' : 'light').catch(() => {});
  }, [darkMode]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const { password: _pw, ...safeForm } = form;
    const prefs = createPersistedPreferences({
      form: safeForm as unknown as Parameters<typeof createPersistedPreferences>[0]['form'],
      savedRooms,
      mediaLibrary,
      controlPasswords: {},
      autosaveJoinedRooms,
      hideEmptyRooms,
      syncPaused,
      autoReconnect,
      autoFileSwitch,
      keepPlayingInBackground,
      privacyMode: 'full',
      autoPlayEnabled: false,
      autoPlayThreshold: 2,
      timeOffset,
      loopMode,
    });
    AsyncStorage.setItem(PREFERENCES_STORAGE_KEY, serializePersistedPreferences(prefs));
  }, [
    autosaveJoinedRooms, autoFileSwitch, autoReconnect, form, hideEmptyRooms,
    keepPlayingInBackground, mediaLibrary, preferencesLoaded, savedRooms,
    syncPaused, timeOffset, loopMode,
  ]);

  useEffect(() => {
    player.staysActiveInBackground = keepPlayingInBackground;
  }, [keepPlayingInBackground, player]);

  // ── App state (background) ──────────────────────────────────────────────

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' && media) {
        connection.sendPlaystate(player.currentTime, !player.playing, true);
        if (!keepPlayingInBackground && player.playing) {
          player.pause();
        }
      }
    });
    return () => subscription.remove();
  }, [connection, keepPlayingInBackground, player, media]);

  // ── Sync correction ─────────────────────────────────────────────────────

  useEffect(() => {
    const correction = calculateSyncCorrection({
      hasMedia: !!media,
      syncPaused,
      localPosition: player.currentTime,
      remotePosition: playstate.position,
      remotePaused: playstate.paused,
      localPlaying: player.playing,
      doSeek: playstate.doSeek,
      timeOffset,
    });

    isApplyingRemoteRef.current = true;
    player.playbackRate = correction.rate;
    if (typeof correction.seekTo === 'number') {
      player.currentTime = correction.seekTo;
    }

    if (correction.shouldPause) {
      player.pause();
    } else if (correction.shouldPlay) {
      player.play();
    }
    setTimeout(() => {
      isApplyingRemoteRef.current = false;
    }, 250);
  }, [player, media, playstate.paused, playstate.position, playstate.setBy, syncPaused, playstate.speed, timeOffset, form.username]);

  // ── Playback events → P2P ───────────────────────────────────────────────

  useEventListener(player, 'playingChange', event => {
    if (!media || isApplyingRemoteRef.current) return;
    connection.sendPlaystate(player.currentTime, !event.isPlaying, false);
  });

  // ── Playlist auto-apply ─────────────────────────────────────────────────

  useEffect(() => {
    const index = playlist.index;
    const item = typeof index === 'number' ? playlist.files[index] : null;
    if (!item) return;

    const applyKey = `${index}:${item}`;
    if (lastAppliedPlaylistKeyRef.current === applyKey) return;
    lastAppliedPlaylistKeyRef.current = applyKey;
    openPlaylistItem(item);
  }, [mediaLibrary, playlist.files, playlist.index]);

  // ── Auto file switch ────────────────────────────────────────────────────

  useEffect(() => {
    if (connectionState !== 'ready' || !autoFileSwitch || mediaLibrary.length === 0) return;

    const candidate = roomPeers.find(peer => {
      if (peer.username === form.username || !peer.file?.name) return false;
      if (media?.name === peer.file.name) return false;
      return Boolean(findMediaByName(mediaLibrary, peer.file.name));
    });

    if (!candidate?.file?.name || lastAutoFileSwitchRef.current === candidate.file.name) return;
    lastAutoFileSwitchRef.current = candidate.file.name;
    openLibraryFileByName(candidate.file.name);
  }, [autoFileSwitch, connectionState, mediaLibrary, roomPeers, media?.name, form.username]);

  // ── Screen auto-switch ──────────────────────────────────────────────────

  useEffect(() => {
    const connected = connectionState === 'ready';
    if (connected && activeScreen === 'connect') {
      setActiveScreen('watch');
    } else if (!connected && activeScreen !== 'connect') {
      setActiveScreen('connect');
    }
  }, [activeScreen, connectionState]);

  useEffect(() => {
    setRoomListDraft(savedRooms.join('\n'));
  }, [savedRooms]);

  // ── Playlist auto-advance ───────────────────────────────────────────────

  useEffect(() => {
    if (!media || loopMode === 'single') return;

    const playerStatus = player.status;
    const nearEnd = player.duration > 0 && player.currentTime >= player.duration - 0.5;

    if (playerStatus === 'readyToPlay' && nearEnd) {
      const currentIndex = playlist.index;
      const nextIndex = typeof currentIndex === 'number' ? currentIndex + 1 : 0;

      if (nextIndex < playlist.files.length) {
        connection.stateManager.setPlaylistIndex(nextIndex);
        openPlaylistItem(playlist.files[nextIndex]!);
      } else if (loopMode === 'playlist') {
        connection.stateManager.setPlaylistIndex(0);
        const first = playlist.files[0];
        if (first) openPlaylistItem(first);
      }
    }
  }, [loopMode, player.currentTime, player.duration, player.status, media, playlist.files, playlist.index, connection]);

  // ── Actions ─────────────────────────────────────────────────────────────

  function updateForm(key: ConnectionTextField, value: string) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function connect() {
    const host = form.host.trim();
    if (!host) {
      setConnectionError('Enter a host address.');
      setConnectionState('error');
      return;
    }

    const isLocal = host.startsWith('localhost') || host.startsWith('127.');
    const protocol = isLocal ? 'ws' : 'wss';
    const config: P2PConnectionConfig = {
      signalingUrl: `${protocol}://${host}:8998`,
      username: form.username.trim() || 'Mobile',
      room: form.room.trim() || 'default',
      ...(form.password.trim() ? { password: form.password.trim() } : {}),
      ...(form.turnUrl.trim() ? { turnUrl: form.turnUrl.trim() } : {}),
    };

    manualDisconnectRef.current = false;
    lastConnectionConfigRef.current = config;
    setConnectionError(null);
    setConnectionState('connecting');

    connection.connect(config).catch(err => {
      setConnectionError(String(err));
      setConnectionState('error');
    });

    // Watch for the stateManager's connection state changes
    const checkState = setInterval(() => {
      const cs = connection.stateManager.connectionState;
      setConnectionState(cs);
      if (cs === 'ready') {
        // Refresh full snapshot on connect
        const snap = connection.stateManager.getSnapshot();
        setPlaystate({
          position: snap.position,
          paused: snap.paused,
          setBy: snap.setBy,
          speed: snap.speed,
          doSeek: snap.doSeek,
        });
        setPlaylist({
          files: snap.playlist.map(f => f.name),
          index: snap.playlistIndex,
        });
        setRoomPeers(Object.values(snap.peers));
        setIsReady(snap.readyStates[form.username] ?? false);
      }
      if (cs === 'error' || cs === 'offline') {
        clearInterval(checkState);
      }
    }, 300);

    // Cleanup after connection settles
    setTimeout(() => clearInterval(checkState), 15000);
  }

  function disconnect() {
    manualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Stop voice capture
    voiceChatRef.current?.stopCapture().catch(() => {});
    connection.disconnect();
    setConnectionState('offline');
    setConnectionError(null);
    setRoomPeers([]);
  }

  async function pickMedia() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['video/*', 'text/*', 'application/*'],
      copyToCacheDirectory: false,
      multiple: true
    });

    if (result.canceled || !result.assets[0]) return;

    // Separate videos and subtitles
    const videoAssets = result.assets.filter(a => {
      const name = a.name.toLowerCase();
      const mime = (a.mimeType ?? '').toLowerCase();
      if (mime.startsWith('video/')) return true;
      return name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.avi') ||
             name.endsWith('.webm') || name.endsWith('.mov');
    });

    const subtitleAssets = result.assets.filter(a => {
      const name = a.name.toLowerCase();
      return name.endsWith('.srt') || name.endsWith('.ass') || name.endsWith('.ssa') ||
             name.endsWith('.vtt') || name.endsWith('.sub') || name.endsWith('.idx') ||
             name.endsWith('.txt');
    });

    const allItems = rememberMediaAssets(result.assets);
    const videoItems = allItems.filter(item => {
      const name = item.name.toLowerCase();
      const uri = item.uri.toLowerCase();
      return videoAssets.some(v => v.uri === item.uri) ||
             name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.avi') ||
             name.endsWith('.webm') || name.endsWith('.mov');
    });

    const videoItem = videoItems[0];
    if (!videoItem) {
      setConnectionError('No video file found in selection.');
      return;
    }

    // Detect subtitles
    if (subtitleAssets.length > 0) {
      const subtitleFiles = subtitleAssets.map(a => ({ name: a.name, size: a.size ?? 0 }));
      const tracks = connection.manager.findSubtitles(subtitleFiles, videoItem.name);
      setSubtitleTracks(tracks);

      if (tracks.length > 0) {
        const trackDesc = tracks
          .map(t => t.language ? `${t.filename} [${t.language}]` : t.filename)
          .join(', ');
        setMessages(prev => [...prev, {
          id: nextMessageId(),
          text: `Found ${tracks.length} subtitle file${tracks.length > 1 ? 's' : ''}: ${trackDesc}.`,
          kind: 'system',
          createdAt: Date.now(),
        }].slice(-500));
      }
    } else {
      setSubtitleTracks([]);
    }

    loadMediaItem(videoItem);
  }

  async function pickMediaSearchFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['video/*', 'text/*', 'application/*'],
      copyToCacheDirectory: false,
      multiple: true
    });

    if (result.canceled || result.assets.length === 0) return;

    // Separate videos and subtitles
    const videoAssets = result.assets.filter(a => {
      const name = a.name.toLowerCase();
      const mime = (a.mimeType ?? '').toLowerCase();
      if (mime.startsWith('video/')) return true;
      return name.endsWith('.mkv') || name.endsWith('.mp4') || name.endsWith('.avi') ||
             name.endsWith('.webm') || name.endsWith('.mov');
    });

    const subtitleAssets = result.assets.filter(a => {
      const name = a.name.toLowerCase();
      return name.endsWith('.srt') || name.endsWith('.ass') || name.endsWith('.ssa') ||
             name.endsWith('.vtt') || name.endsWith('.sub') || name.endsWith('.idx') ||
             name.endsWith('.txt');
    });

    const addedItems = rememberMediaAssets(result.assets);

    if (!mediaUri && addedItems[0]) {
      // Detect subtitles
      if (subtitleAssets.length > 0) {
        const subtitleFiles = subtitleAssets.map(a => ({ name: a.name, size: a.size ?? 0 }));
        const tracks = connection.manager.findSubtitles(subtitleFiles, addedItems[0].name);
        setSubtitleTracks(tracks);

        if (tracks.length > 0) {
          const trackDesc = tracks
            .map(t => t.language ? `${t.filename} [${t.language}]` : t.filename)
            .join(', ');
          setMessages(prev => [...prev, {
            id: nextMessageId(),
            text: `Found ${tracks.length} subtitle file${tracks.length > 1 ? 's' : ''}: ${trackDesc}.`,
            kind: 'system',
            createdAt: Date.now(),
          }].slice(-500));
        }
      } else {
        setSubtitleTracks([]);
      }

      loadMediaItem(addedItems[0]);
    }
  }

  async function pickMediaSearchDirectory() {
    try {
      const directory = await Directory.pickDirectoryAsync();
      const scannedItems = scanMediaDirectory(directory, {
        maxDepth: Platform.OS === 'android' ? 4 : 1,
        maxFiles: 750
      });
      if (scannedItems.length === 0) {
        setConnectionError('No supported video files found in that folder.');
        return;
      }

      const nextItems = addMediaItems(mediaLibrary, scannedItems);
      setMediaLibrary(nextItems);

      if (!mediaUri) {
        const firstItem = nextItems.find(item => item.uri === scannedItems[0]?.uri);
        if (firstItem) loadMediaItem(firstItem);
      }
      setMissingMediaName(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not read that folder.');
    }
  }

  function rememberMediaAssets(assets: DocumentPickerAsset[]): MediaLibraryItem[] {
    const incomingItems = assets.map(assetToMediaLibraryItem);
    const nextItems = addMediaItems(mediaLibrary, incomingItems);
    const nextItemsByUri = new Map(nextItems.map(item => [item.uri, item]));
    setMediaLibrary(nextItems);
    return incomingItems
      .map(item => nextItemsByUri.get(item.uri))
      .filter((item): item is MediaLibraryItem => item !== undefined);
  }

  function loadMediaItem(item: MediaLibraryItem) {
    const file: SyncplayFile = {
      name: item.name,
      duration: item.duration ?? 0,
      size: item.size
    };

    setMediaUri(item.uri);
    setMedia(file);
    setMissingMediaName(null);

    // Attach subtitle tracks to state manager and send file info
    connection.manager.setSubtitleTracks(subtitleTracks);
    connection.sendFileInfo(file);
  }

  function openLibraryFileByName(filename: string | null) {
    const item = findMediaByName(mediaLibrary, filename);
    if (!item) return;
    loadMediaItem(item);
  }

  function openStream() {
    const url = streamUrl.trim();
    if (!url) return;
    openStreamUri(url);
    setStreamUrl('');
  }

  function openStreamUri(url: string) {
    const file: SyncplayFile = { name: url, duration: 0, size: 0 };
    setMediaUri(url);
    setMedia(file);
    setMissingMediaName(null);
  }

  function sendChat() {
    const trimmed = chatDraft.trim();
    if (!trimmed) return;

    const commandResult = parseSlashCommand(trimmed, form.username);

    if (commandResult) {
      switch (commandResult.kind) {
        case 'chat':
          connection.sendChat(commandResult.text);
          break;
        case 'me':
          connection.sendChat(`* ${form.username} ${commandResult.action}`);
          break;
        case 'nick':
          updateForm('username', commandResult.username);
          break;
        case 'topic':
          // Not supported in P2P — just send as chat
          connection.sendChat(`Topic: ${commandResult.topic}`);
          break;
        case 'help':
          setMessages(prev => [...prev, {
            id: nextMessageId(),
            text: commandResult.commands,
            kind: 'system',
            createdAt: Date.now(),
          }].slice(-500));
          break;
      }
    } else {
      // Try P2P slash commands
      const p2pResult = connection.sendSlashCommand(trimmed);
      if (p2pResult) {
        setMessages(prev => [...prev, {
          id: nextMessageId(),
          text: p2pResult,
          kind: 'system',
          createdAt: Date.now(),
        }].slice(-500));
      } else {
        // Add locally before sending (so sender sees own message)
        setMessages(prev => [...prev, {
          id: nextMessageId(),
          text: trimmed,
          username: form.username,
          kind: 'chat',
          createdAt: Date.now(),
        }].slice(-500));
        connection.sendChat(trimmed);
      }
    }

    setChatDraft('');
  }

  function toggleReady() {
    const next = !isReady;
    setIsReady(next);
    connection.sendReadiness(next);
  }

  function togglePlayback() {
    if (player.playing) {
      player.pause();
    } else {
      player.play();
    }
  }

  function handleSetSpeed(speed: number) {
    connection.requestSetSpeed(speed);
  }

  function toggleVoiceMute() {
    const vc = voiceChatRef.current;
    if (!vc) {
      // Fallback if VoiceChat not initialized
      const muted = connection.toggleMute();
      setVoiceMuted(muted);
      return;
    }
    const muted = vc.toggleMute();
    setVoiceMuted(muted);
    // Start/stop capture based on mute state
    if (muted) {
      vc.stopCapture().catch(() => {});
    } else {
      vc.startCapture().catch(() => {});
    }
  }

  function seekFromInput() {
    const nextPosition = parseTimestamp(seekDraft);
    if (nextPosition === null) {
      setConnectionError('Enter a time like 1:23 or 1:02:03.');
      return;
    }

    previousSeekPositionRef.current = player.currentTime;
    player.currentTime = nextPosition;
    connection.sendPlaystate(nextPosition, !player.playing, true);
  }

  function undoSeek() {
    const previousPosition = previousSeekPositionRef.current;
    if (previousPosition === null) return;

    previousSeekPositionRef.current = player.currentTime;
    player.currentTime = previousPosition;
    setSeekDraft(formatTime(previousPosition));
    connection.sendPlaystate(previousPosition, !player.playing, true);
  }

  function addCurrentMediaToPlaylist() {
    if (media?.name) {
      sendPlaylist([...playlist.files, media.name]);
    }
  }

  function addPlaylistUrl() {
    const url = playlistUrl.trim();
    if (!url) return;
    sendPlaylist([...playlist.files, url]);
    setPlaylistUrl('');
  }

  function clearPlaylist() {
    connection.stateManager.clearPlaylist();
    setPlaylist({ files: [], index: 0 });
  }

  function shufflePlaylistAction() {
    sendPlaylist(shuffleFiles(playlist.files));
  }

  function playPlaylistIndex(index: number) {
    const item = playlist.files[index];
    if (!item) return;
    connection.stateManager.setPlaylistIndex(index);
    openPlaylistItem(item);
  }

  function openPlaylistItem(item: string) {
    const resolved = resolvePlaylistItem([item], 0, mediaLibrary);
    if (resolved.kind === 'stream') {
      openStreamUri(resolved.uri);
      return;
    }
    if (resolved.kind === 'local') {
      loadMediaItem(resolved.item);
      return;
    }
    if (resolved.kind === 'missing') {
      setMissingMediaName(resolved.filename);
      setConnectionError(`Could not find ${resolved.filename} in media search.`);
    }
  }

  function sendPlaylist(files: string[]) {
    const deduped = Array.from(new Set(files.map(file => file.trim()).filter(Boolean)));
    connection.stateManager.setPlaylist(deduped);
    // Optimistically update local playlist state
    setPlaylist(prev => ({ ...prev, files: deduped }));
  }

  function joinRoom() {
    const room = form.room.trim() || 'default';
    updateForm('room', room);
    if (autosaveJoinedRooms) {
      const rooms = [...new Set([room, ...savedRooms])].sort();
      setSavedRooms(rooms);
    }
    disconnect();
    setTimeout(() => connect(), 300);
  }

  function saveRoomListFromDraft() {
    const rooms = roomListDraft
      .split(/\r?\n/)
      .map(room => room.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
    setSavedRooms(Array.from(new Set(rooms)));
  }

  function addCurrentRoomToList() {
    const rooms = [...new Set([form.room, ...savedRooms])].sort();
    setSavedRooms(rooms);
    setRoomListDraft(rooms.join('\n'));
  }

  const connected = connectionState === 'ready';
  const mediaDirectoryLabels = buildDirectoryLabels(mediaLibrary);

  // ── Render ──────────────────────────────────────────────────────────────

  const screenContent =
    activeScreen === 'connect' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <Plug color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Connection</Text>
        </View>
        <View style={styles.connectionSummary}>
          <SummaryItem label="Host" value={form.host || 'host'} />
          <SummaryItem label="Username" value={form.username.trim() || 'Mobile'} />
          <SummaryItem label="Room" value={form.room.trim() || 'default'} />
          <SummaryItem label="Protocol" value="P2P v2.0" />
        </View>
        <Field
          label="Host address"
          value={form.host}
          onChangeText={value => updateForm('host', value)}
          autoCapitalize="none"
        />
        <View style={styles.gridTwo}>
          <Field
            label="Username"
            value={form.username}
            onChangeText={value => updateForm('username', value)}
          />
          <Field label="Room" value={form.room} onChangeText={value => updateForm('room', value)} />
        </View>
        <Field
          label="Password"
          value={form.password}
          onChangeText={value => updateForm('password', value)}
          secureTextEntry
        />
        <Field
          label="TURN server (optional)"
          value={form.turnUrl}
          onChangeText={value => updateForm('turnUrl', value)}
          autoCapitalize="none"
        />
        <View style={styles.avatarSection}>
          <Text style={styles.label}>Avatar</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarRow}>
            {AVATAR_PRESETS.map(preset => (
              <Pressable
                key={preset.id}
                style={[
                  styles.avatarButton,
                  selectedAvatarId === preset.id && styles.avatarButtonSelected,
                ]}
                onPress={() => {
                  setSelectedAvatarId(preset.id);
                  if (connected) connection.setAvatar(preset.id, '', preset.accent);
                }}
              >
                <Text style={styles.avatarEmoji}>{preset.emoji}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <View style={styles.buttonRow}>
          <ActionButton
            label={connected ? 'Disconnect' : 'Connect'}
            icon={connected ? DoorOpen : Plug}
            tone={connected ? 'ghost' : 'primary'}
            onPress={connected ? disconnect : connect}
          />
        </View>
        {connectionError ? <Text style={styles.errorText}>{connectionError}</Text> : null}
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <MonitorPlay color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Media Player</Text>
        </View>
        <View style={styles.serverOptionGrid}>
          <View style={[styles.serverOption, styles.serverOptionSelected]}>
            <Text style={[styles.serverOptionText, styles.serverOptionTextSelected]}>Native synced</Text>
          </View>
        </View>
        <Text style={styles.smallText}>
          External mobile players cannot report reliable position, pause, play, or seek events back to Syncplay.
        </Text>
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <Library color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Media Search</Text>
          <Text style={styles.countText}>{mediaLibrary.length}</Text>
        </View>
        {mediaDirectoryLabels.length > 0 ? (
          <View style={styles.serverOptionGrid}>
            {mediaDirectoryLabels.map(directory => (
              <View key={directory} style={styles.serverOption}>
                <Text style={styles.serverOptionText}>{directory}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.mutedText}>No media added.</Text>
        )}
        {missingMediaName ? <Text style={styles.errorText}>Missing: {missingMediaName}</Text> : null}
        <View style={styles.buttonRow}>
          <ActionButton label="Add Media Files" icon={FolderOpen} tone="ghost" onPress={pickMediaSearchFiles} />
          <ActionButton label="Add Folder" icon={FolderOpen} tone="ghost" onPress={pickMediaSearchDirectory} />
        </View>
      </View>
    ) : activeScreen === 'watch' ? (
      <>
        <View style={styles.videoShell}>
          {mediaUri ? (
            <VideoView
              style={styles.video}
              player={player}
              nativeControls
              contentFit="contain"
              allowsPictureInPicture
            />
          ) : (
            <View style={styles.emptyVideo}>
              <Film color="#8fa3b8" size={36} />
              <Text style={styles.emptyTitle}>Pick a local video</Text>
              <Text style={styles.emptyCopy}>Use the same file as everyone else in the room.</Text>
            </View>
          )}
        </View>

        <View style={styles.transport}>
          <Pressable style={styles.roundButton} onPress={togglePlayback} disabled={!mediaUri}>
            {playingEvent.isPlaying ? (
              <Pause color="#061015" size={24} />
            ) : (
              <Play color="#061015" size={24} />
            )}
          </Pressable>
          <View style={styles.transportMeta}>
            <Text style={styles.mediaName} numberOfLines={1}>
              {media?.name ?? 'No media loaded'}
            </Text>
            <Text style={styles.smallText}>
              {formatTime(timeEvent.currentTime)} / {formatTime(player.duration || 0)}
              {statusEvent.status ? ` · ${statusEvent.status}` : ''}
            </Text>
          </View>
          <Pressable style={styles.secondaryIconButton} onPress={pickMedia}>
            <Film color="#d7e5ef" size={20} />
          </Pressable>
          <Pressable
            style={styles.secondaryIconButton}
            onPress={toggleVoiceMute}
            disabled={!connected}
          >
            <Text style={{ fontSize: 18 }}>{voiceMuted ? '🔇' : '🎤'}</Text>
          </Pressable>
        </View>

        <View style={styles.panel}>
          <View style={styles.panelTitleRow}>
            <Clock color="#7fd2ff" size={18} />
            <Text style={styles.panelTitle}>Playback</Text>
          </View>
          <View style={styles.inlineRow}>
            <Field label="Seek" value={seekDraft} onChangeText={setSeekDraft} />
            <ActionButton label="Go" icon={Clock} tone="ghost" onPress={seekFromInput} disabled={!mediaUri} />
            <ActionButton
              label="Undo"
              icon={Undo2}
              tone="ghost"
              onPress={undoSeek}
              disabled={previousSeekPositionRef.current === null}
            />
          </View>
          <View style={styles.inlineRow}>
            <Text style={styles.smallText}>Speed:</Text>
            <ActionButton label="0.5x" tone={playstate.speed === 0.5 ? 'primary' : 'ghost'} onPress={() => handleSetSpeed(0.5)} disabled={!connected} />
            <ActionButton label="1x" tone={playstate.speed === 1 ? 'primary' : 'ghost'} onPress={() => handleSetSpeed(1)} disabled={!connected} />
            <ActionButton label="2x" tone={playstate.speed === 2 ? 'primary' : 'ghost'} onPress={() => handleSetSpeed(2)} disabled={!connected} />
          </View>
          <View style={styles.inlineRow}>
            <Field label="Stream URL" value={streamUrl} onChangeText={setStreamUrl} autoCapitalize="none" />
            <ActionButton label="Open" icon={Link} tone="ghost" onPress={openStream} />
          </View>
        </View>
        <View style={styles.panel}>
          <View style={styles.panelTitleRow}>
            <Library color="#7fd2ff" size={18} />
            <Text style={styles.panelTitle}>Media Search</Text>
            <Text style={styles.countText}>{mediaLibrary.length}</Text>
          </View>
          {missingMediaName ? <Text style={styles.errorText}>Missing: {missingMediaName}</Text> : null}
          <View style={styles.buttonRow}>
            <ActionButton label="Add Media Files" icon={FolderOpen} tone="ghost" onPress={pickMediaSearchFiles} />
            <ActionButton label="Add Folder" icon={FolderOpen} tone="ghost" onPress={pickMediaSearchDirectory} />
          </View>
          <FlatList
            data={mediaLibrary.slice(0, 8)}
            keyExtractor={item => item.uri}
            scrollEnabled={false}
            ListEmptyComponent={<Text style={styles.mutedText}>No media added.</Text>}
            renderItem={({ item }) => (
              <Pressable style={styles.mediaLibraryRow} onPress={() => loadMediaItem(item)}>
                <Film color="#8fa3b8" size={16} />
                <Text style={styles.playlistText} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.countText}>{formatBytes(item.size)}</Text>
                <Pressable
                  style={styles.userReadyButton}
                  onPress={() => {
                    const dir = item.uri.substring(0, item.uri.lastIndexOf('/'));
                    if (dir) void Linking.openURL(dir);
                  }}
                >
                  <FolderOpen color="#d7e5ef" size={14} />
                </Pressable>
              </Pressable>
            )}
          />
        </View>
      </>
    ) : activeScreen === 'room' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <Users color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>{form.room}</Text>
          <Text style={styles.countText}>{roomPeers.length}</Text>
        </View>
        {transferProgress.length > 0 ? (
          <View style={styles.transferSection}>
            {transferProgress.map(t => (
              <View key={t.transferId} style={styles.transferItem}>
                <Text style={styles.transferName} numberOfLines={1}>{t.filename}</Text>
                <View style={styles.transferBarTrack}>
                  <View style={[styles.transferBarFill, { width: `${Math.round(t.progress * 100)}%` }]} />
                </View>
                <Text style={styles.transferPct}>{Math.round(t.progress * 100)}%</Text>
              </View>
            ))}
          </View>
        ) : null}
        <FlatList
          data={roomPeers}
          keyExtractor={item => item.username}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No peers connected.</Text>}
          renderItem={({ item }) => {
            const iceColor =
              item.iceState === 'connected' ? '#4ade80' :
              item.iceState === 'checking' ? '#facc15' :
              item.iceState === 'failed' || item.iceState === 'disconnected' ? '#ef4444' :
              '#9ca3af';
            const emoji = getAvatarEmoji(item.avatar?.presetId);
            return (
            <View style={styles.userRow}>
              <View style={styles.userAvatar}>
                {emoji ? (
                  <Text style={styles.avatarEmoji}>{emoji}</Text>
                ) : (
                  <Text style={styles.userInitial}>{item.username.slice(0, 1).toUpperCase()}</Text>
                )}
              </View>
              <View style={styles.userMain}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={[styles.iceDot, { backgroundColor: iceColor }]} />
                  <Text style={styles.userName}>
                    {item.username}
                    {item.username === form.username ? ' (you)' : ''}
                    {item.isHost ? ' · host' : ''}
                    {item.isController ? ' · controller' : ''}
                    {item.rtt > 0 ? ` (${item.rtt}ms)` : ''}
                  </Text>
                </View>
                {item.status?.text ? (
                  <Text style={styles.peerStatusText} numberOfLines={1}>
                    {item.status.text}
                  </Text>
                ) : null}
                <Text style={styles.smallText} numberOfLines={1}>
                  {item.file?.name ?? 'No file'} {item.file ? `· ${formatBytes(item.file.size)}` : ''}
                </Text>
              </View>
              <View style={[styles.readyBadge, item.isReady && styles.readyBadgeOn]}>
                <Text style={[styles.readyText, item.isReady && styles.readyTextOn]}>
                  {item.isReady ? 'Ready' : 'Wait'}
                </Text>
              </View>
              {item.file?.name && findMediaByName(mediaLibrary, item.file.name) ? (
                <Pressable style={styles.userReadyButton} onPress={() => openLibraryFileByName(item.file?.name ?? null)}>
                  {/^[a-z][a-z\d+.-]*:\/\//i.test(item.file.name) ? (
                    <Globe color="#d7e5ef" size={16} />
                  ) : (
                    <Film color="#d7e5ef" size={16} />
                  )}
                </Pressable>
              ) : null}
            </View>
            );
          }}
        />
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <Users color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Join Room</Text>
        </View>
        <View style={styles.inlineRow}>
          <Field label="Room" value={form.room} onChangeText={value => updateForm('room', value)} />
          <ActionButton label="Join" icon={Users} tone="ghost" onPress={joinRoom} disabled={!connected} />
        </View>
        <View style={styles.buttonRow}>
          <ActionButton
            label={isReady ? 'Ready' : 'Not Ready'}
            icon={Check}
            tone={isReady ? 'primary' : 'ghost'}
            onPress={toggleReady}
            disabled={!connected}
          />
          <ActionButton label="Remember" icon={ListPlus} tone="ghost" onPress={addCurrentRoomToList} />
          <Pressable
            style={[styles.switchPill, autosaveJoinedRooms && styles.switchPillOn]}
            onPress={() => setAutosaveJoinedRooms(value => !value)}
          >
            <Text style={[styles.switchText, autosaveJoinedRooms && styles.switchTextOn]}>
              {autosaveJoinedRooms ? 'Autosave joins' : 'Manual saves'}
            </Text>
          </Pressable>
        </View>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={roomListDraft}
          onChangeText={setRoomListDraft}
          multiline
          autoCapitalize="none"
          placeholder="Saved rooms, one per line"
          placeholderTextColor="#64788b"
        />
        <View style={styles.buttonRow}>
          <ActionButton label="Save Room List" icon={ListPlus} tone="ghost" onPress={saveRoomListFromDraft} />
        </View>
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <ListPlus color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Playlist</Text>
          <Text style={styles.countText}>{playlist.files.length}</Text>
        </View>
        <FlatList
          data={playlist.files}
          keyExtractor={(item, index) => `${item}-${index}`}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No playlist yet.</Text>}
          renderItem={({ item, index }) => (
            <Pressable
              style={[styles.playlistRow, playlist.index === index && styles.playlistRowActive]}
              onPress={() => playPlaylistIndex(index)}
            >
              <Text style={styles.playlistIndex}>{index + 1}</Text>
              <Text style={styles.playlistText} numberOfLines={1}>
                {item}
              </Text>
            </Pressable>
          )}
        />
        <View style={styles.inlineRow}>
          <Field label="Playlist URL" value={playlistUrl} onChangeText={setPlaylistUrl} autoCapitalize="none" />
          <ActionButton label="Add" icon={ListPlus} tone="ghost" onPress={addPlaylistUrl} disabled={!connected} />
        </View>
        <View style={styles.buttonRow}>
          <ActionButton
            label="Add Current"
            icon={Film}
            tone="ghost"
            onPress={addCurrentMediaToPlaylist}
            disabled={!connected || !media}
          />
          <ActionButton
            label="Shuffle"
            icon={Shuffle}
            tone="ghost"
            onPress={shufflePlaylistAction}
            disabled={!connected || playlist.files.length < 2}
          />
          <ActionButton
            label="Clear"
            icon={Trash2}
            tone="ghost"
            onPress={clearPlaylist}
            disabled={!connected || playlist.files.length === 0}
          />
        </View>
      </View>
    ) : activeScreen === 'chat' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <MessageCircle color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Chat</Text>
        </View>
        <View style={styles.statusSection}>
          <Text style={styles.label}>Status</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarRow}>
            {STATUS_PRESETS.map(([_, text]) => (
              <Pressable
                key={text}
                style={[
                  styles.statusButton,
                  selectedStatusText === text && styles.statusButtonSelected,
                ]}
                onPress={() => {
                  setSelectedStatusText(text);
                  if (connected) connection.setStatus(text);
                }}
              >
                <Text
                  style={[
                    styles.statusBtnText,
                    selectedStatusText === text && styles.statusBtnTextSelected,
                  ]}
                  numberOfLines={1}
                >
                  {text}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <FlatList
          data={messages}
          keyExtractor={item => item.id}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>Messages will appear here.</Text>}
          renderItem={({ item }) => (
            <View style={styles.messageRow}>
              <View style={styles.messageHeader}>
                <Text style={item.kind === 'chat' ? styles.messageUser : styles.messageKind}>
                  {item.kind === 'chat' ? item.username : item.kind}
                </Text>
                <Text style={styles.messageTime}>
                  {formatClockTime(item.createdAt)}
                </Text>
              </View>
              <Text style={styles.messageText}>{item.text}</Text>
            </View>
          )}
        />
        <View style={styles.chatInputRow}>
          <TextInput
            style={styles.chatInput}
            value={chatDraft}
            onChangeText={setChatDraft}
            placeholder="Message"
            placeholderTextColor="#64788b"
            editable={connected}
          />
          <Pressable style={styles.sendButton} onPress={sendChat} disabled={!connected || !chatDraft.trim()}>
            <Send color="#061015" size={18} />
          </Pressable>
        </View>
      </View>
    ) : (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <SettingsIcon color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Client Options</Text>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Sync corrections</Text>
            <Text style={styles.smallText}>Hold remote play and seek updates when you need local control.</Text>
          </View>
          <Pressable
            style={[styles.switchPill, syncPaused && styles.switchPillOn]}
            onPress={() => setSyncPaused(value => !value)}
          >
            <Text style={[styles.switchText, syncPaused && styles.switchTextOn]}>
              {syncPaused ? 'Held' : 'Active'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Auto reconnect</Text>
            <Text style={styles.smallText}>Try the last server again after socket errors.</Text>
          </View>
          <Pressable
            style={[styles.switchPill, autoReconnect && styles.switchPillOn]}
            onPress={() => setAutoReconnect(value => !value)}
          >
            <Text style={[styles.switchText, autoReconnect && styles.switchTextOn]}>
              {autoReconnect ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Auto file switch</Text>
            <Text style={styles.smallText}>Open matching media when someone in the room loads it.</Text>
          </View>
          <Pressable
            style={[styles.switchPill, autoFileSwitch && styles.switchPillOn]}
            onPress={() => setAutoFileSwitch(value => !value)}
          >
            <Text style={[styles.switchText, autoFileSwitch && styles.switchTextOn]}>
              {autoFileSwitch ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Background playback</Text>
            <Text style={styles.smallText}>Keep the native player active after the app backgrounds.</Text>
          </View>
          <Pressable
            style={[styles.switchPill, keepPlayingInBackground && styles.switchPillOn]}
            onPress={() => setKeepPlayingInBackground(value => !value)}
          >
            <Text style={[styles.switchText, keepPlayingInBackground && styles.switchTextOn]}>
              {keepPlayingInBackground ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Time offset</Text>
            <Text style={styles.smallText}>Seconds to shift your playback. +1.5 or -0.5.</Text>
          </View>
          <TextInput
            style={[styles.input, { width: 80, textAlign: 'center' }]}
            value={String(timeOffset)}
            onChangeText={value => {
              const num = parseFloat(value);
              if (!Number.isNaN(num)) {
                setTimeOffset(num);
              } else if (value === '' || value === '-') {
                setTimeOffset(0);
              }
            }}
            keyboardType="numeric"
            placeholderTextColor="#64788b"
          />
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Loop mode</Text>
            <Text style={styles.smallText}>Single loop / playlist loop / no loop.</Text>
          </View>
          <View style={styles.inlineRow}>
            {(['none', 'single', 'playlist'] as LoopMode[]).map(mode => (
              <Pressable
                key={mode}
                style={[
                  styles.switchPill,
                  loopMode === mode && styles.switchPillOn
                ]}
                onPress={() => setLoopMode(mode)}
              >
                <Text style={[styles.switchText, loopMode === mode && styles.switchTextOn]}>
                  {mode === 'none' ? 'Off' : mode === 'single' ? 'Single' : 'List'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingText}>
            <Text style={styles.userName}>Current connection</Text>
            <Text style={styles.smallText}>
              {form.host} · {form.username} · {form.room}
            </Text>
          </View>
          <ActionButton
            label={connected ? 'Disconnect' : 'Connect'}
            icon={connected ? DoorOpen : Plug}
            tone={connected ? 'ghost' : 'primary'}
            onPress={connected ? disconnect : connect}
          />
        </View>
      </View>
    );

  const themeBg = darkMode ? '#0e0e14' : '#f5f5f5';
  const themeText = darkMode ? '#e1e1f0' : '#1a1a2e';

  return (
    <ErrorBoundary>
    <SafeAreaView style={[styles.safe, { backgroundColor: themeBg }]}>
      <StatusBar barStyle={darkMode ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({ ios: 'padding', android: undefined })}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View>
              <Text style={styles.brand}>Syncplay P2P</Text>
              <Text style={styles.screenTitle}>{getScreenTitle(activeScreen)}</Text>
              <Text style={styles.statusText}>
                {statusLabel(connectionState)}
                {connected ? ` · ${roomPeers.length} peer${roomPeers.length !== 1 ? 's' : ''}` : ''}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Pressable
                style={styles.darkModeToggle}
                onPress={() => setShowHelp(true)}
                accessibilityLabel="Open help"
              >
                <HelpCircle color={darkMode ? '#8ea4c0' : '#4a6fa5'} size={20} />
              </Pressable>
              <Pressable
                style={styles.darkModeToggle}
                onPress={() => setDarkMode(d => !d)}
                accessibilityLabel={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? (
                  <Sun color="#f5c542" size={20} />
                ) : (
                  <Moon color="#4a6fa5" size={20} />
                )}
              </Pressable>
              <View style={[styles.statusDot, connected ? styles.dotLive : styles.dotIdle]} />
            </View>
          </View>

          {screenContent}
        </ScrollView>
        <BottomTabs activeScreen={activeScreen} onSelect={setActiveScreen} connected={connected} />
      </KeyboardAvoidingView>
    </SafeAreaView>
      <Modal
        visible={showHelp}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowHelp(false)}
      >
        <View style={styles.helpOverlay}>
          <View style={styles.helpModal}>
            <Text style={styles.helpTitle}>Syncplay P2P Commands</Text>
            <ScrollView
              style={styles.helpScroll}
              contentContainerStyle={styles.helpScrollContent}
              showsVerticalScrollIndicator={true}
            >
              <Text style={styles.helpSection}>Chat Commands</Text>
              {[
                '/help — Show this help',
                '/me <action> — Send an action message',
                '/users — List users in the room',
                '/ready — Toggle ready state',
                '/leave — Leave the room',
                '/version — Show server version',
                '/controller — Request controller role',
                '/playlist — Show playlist',
                '/settings — Open settings',
                '/shrug — ¯\\_(ツ)_/¯',
                '/tableflip — (╯°□°)╯︵ ┻━┻',
                '/lenny — ( ͡° ͜ʖ ͡°)',
              ].map((cmd, i) => (
                <Text key={i} style={styles.helpCommand}>{cmd}</Text>
              ))}
              <Text style={styles.helpSection}>Speed Controls</Text>
              <Text style={styles.helpCommand}>Use the speed buttons in the media bar to adjust playback speed (0.5x, 1x, 1.5x, 2x).</Text>
            </ScrollView>
            <Pressable
              style={[styles.helpCloseButton, { backgroundColor: colors.accent }]}
              onPress={() => setShowHelp(false)}
            >
              <Text style={styles.helpCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ErrorBoundary>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
};

function Field(props: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
        secureTextEntry={props.secureTextEntry}
        keyboardType={props.keyboardType}
        autoCapitalize={props.autoCapitalize}
        placeholderTextColor="#64788b"
      />
    </View>
  );
}

type ActionButtonProps = {
  label: string;
  icon?: typeof Plug;
  tone: 'primary' | 'ghost';
  onPress: () => void;
  disabled?: boolean;
};

function ActionButton({ label, icon: Icon, tone, onPress, disabled }: ActionButtonProps) {
  return (
    <Pressable
      style={[
        styles.actionButton,
        tone === 'primary' ? styles.primaryButton : styles.ghostButton,
        disabled && styles.disabledButton
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {Icon ? <Icon color={tone === 'primary' ? '#061015' : '#d7e5ef'} size={17} /> : null}
      <Text style={[styles.actionText, tone === 'primary' && styles.primaryActionText]}>{label}</Text>
    </Pressable>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryItem}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function BottomTabs({
  activeScreen,
  connected,
  onSelect
}: {
  activeScreen: AppScreenId;
  connected: boolean;
  onSelect: (screen: AppScreenId) => void;
}) {
  const screens = APP_SCREENS.filter(s => s.id !== 'transfers'); // Remove transfers tab
  return (
    <View style={styles.bottomTabs}>
      {screens.map(screen => {
        const active = activeScreen === screen.id;
        const disabled = !connected && screen.id !== 'connect';
        return (
          <Pressable
            key={screen.id}
            style={[styles.tabButton, active && styles.tabButtonActive, disabled && styles.disabledButton]}
            onPress={() => onSelect(screen.id)}
            disabled={disabled}
          >
            {renderTabIcon(screen.id, active ? colors.ink : colors.muted)}
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{screen.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function renderTabIcon(screenId: AppScreenId, color: string) {
  switch (screenId) {
    case 'connect': return <Plug color={color} size={17} />;
    case 'watch': return <Film color={color} size={17} />;
    case 'room': return <Users color={color} size={17} />;
    case 'chat': return <MessageCircle color={color} size={17} />;
    case 'settings': return <SettingsIcon color={color} size={17} />;
    default: return null;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────

const colors = {
  bg: '#061015',
  panel: '#101d25',
  panelSoft: '#142630',
  line: '#263a47',
  text: '#edf7fb',
  muted: '#8fa3b8',
  faint: '#64788b',
  accent: '#7fd2ff',
  green: '#9be28d',
  ink: '#061015',
  error: '#ff8a80'
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1 },
  content: { padding: 16, gap: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
  },
  brand: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: 0 },
  screenTitle: { color: colors.accent, fontSize: 15, fontWeight: '800', marginTop: 6 },
  statusText: { color: colors.muted, fontSize: 13, marginTop: 4 },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  dotLive: { backgroundColor: colors.green },
  dotIdle: { backgroundColor: colors.faint },
  darkModeToggle: {
    width: 36, height: 36, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line, borderWidth: 1,
  },
  videoShell: {
    minHeight: 210,
    borderRadius: 8,
    backgroundColor: '#020608',
    overflow: 'hidden',
    borderColor: colors.line,
    borderWidth: 1,
  },
  video: { width: '100%', aspectRatio: 16 / 9 },
  emptyVideo: { minHeight: 210, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 12 },
  emptyCopy: { color: colors.muted, fontSize: 13, marginTop: 6, textAlign: 'center' },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.panel,
  },
  roundButton: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  transportMeta: { flex: 1, minWidth: 0 },
  mediaName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  secondaryIconButton: {
    width: 42, height: 42, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line, borderWidth: 1,
  },
  panel: {
    borderRadius: 8, padding: 14, gap: 12,
    backgroundColor: colors.panel,
    borderColor: colors.line, borderWidth: 1,
  },
  panelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  panelTitle: { color: colors.text, fontSize: 17, fontWeight: '800', flex: 1 },
  connectionSummary: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  summaryItem: {
    flexGrow: 1, flexBasis: '47%', minHeight: 54,
    borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8,
    justifyContent: 'center', backgroundColor: colors.bg,
    borderColor: colors.line, borderWidth: 1,
  },
  summaryLabel: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  summaryValue: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 4 },
  countText: { color: colors.muted, fontSize: 13 },
  gridTwo: { flexDirection: 'row', gap: 10 },
  inlineRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 2 },
  serverOptionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  serverOption: {
    minHeight: 38, borderRadius: 8, paddingHorizontal: 11,
    justifyContent: 'center', backgroundColor: colors.panelSoft,
    borderColor: colors.line, borderWidth: 1,
  },
  serverOptionSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  serverOptionText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  serverOptionTextSelected: { color: colors.ink },
  field: { flex: 1, gap: 6 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  input: {
    minHeight: 44, borderRadius: 8, paddingHorizontal: 12,
    color: colors.text, backgroundColor: colors.bg,
    borderColor: colors.line, borderWidth: 1,
  },
  textArea: { minHeight: 88, paddingTop: 10, textAlignVertical: 'top' },
  buttonRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  actionButton: {
    minHeight: 42, borderRadius: 8, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  primaryButton: { backgroundColor: colors.accent },
  ghostButton: { backgroundColor: colors.panelSoft, borderColor: colors.line, borderWidth: 1 },
  disabledButton: { opacity: 0.45 },
  actionText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  primaryActionText: { color: colors.ink },
  switchPill: {
    minHeight: 42, borderRadius: 8, paddingHorizontal: 14,
    justifyContent: 'center', backgroundColor: colors.panelSoft,
    borderColor: colors.line, borderWidth: 1,
  },
  switchPillOn: { backgroundColor: '#283222', borderColor: '#557047' },
  switchText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  switchTextOn: { color: colors.green },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, paddingVertical: 10,
    borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth,
  },
  settingText: { flex: 1, minWidth: 0 },
  bottomTabs: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10,
    paddingBottom: Platform.select({ ios: 22, android: 12, default: 12 }),
    backgroundColor: colors.bg, borderTopColor: colors.line, borderTopWidth: 1,
  },
  tabButton: {
    flex: 1, minHeight: 50, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1,
  },
  tabButtonActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabText: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  tabTextActive: { color: colors.ink },
  userRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9,
    borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth,
  },
  userAvatar: {
    width: 34, height: 34, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#243847',
  },
  userInitial: { color: colors.text, fontSize: 14, fontWeight: '800' },
  userMain: { flex: 1, minWidth: 0 },
  userName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  readyBadge: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: '#1c2830' },
  readyBadgeOn: { backgroundColor: '#2c4028' },
  readyText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  readyTextOn: { color: colors.green },
  userReadyButton: {
    width: 34, height: 34, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line, borderWidth: 1,
  },
  playlistRow: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth,
  },
  playlistRowActive: { backgroundColor: colors.panelSoft },
  playlistIndex: { width: 24, color: colors.muted, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  playlistText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, fontWeight: '700' },
  mediaLibraryRow: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth,
  },
  messageRow: {
    paddingVertical: 8,
    borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth,
  },
  messageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  messageUser: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  messageKind: { color: colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  messageTime: { color: colors.faint, fontSize: 11 },
  messageText: { color: colors.text, fontSize: 14, marginTop: 2 },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chatInput: {
    flex: 1, minHeight: 44, borderRadius: 8, paddingHorizontal: 12,
    color: colors.text, backgroundColor: colors.bg,
    borderColor: colors.line, borderWidth: 1,
  },
  sendButton: {
    width: 44, height: 44, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  smallText: { color: colors.muted, fontSize: 12, marginTop: 3 },
  mutedText: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
  errorText: { color: colors.error, fontSize: 13 },
  // Help modal
  helpOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  helpModal: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    borderRadius: 16,
    backgroundColor: '#151520',
    borderColor: '#2a2a3e',
    borderWidth: 1,
    overflow: 'hidden',
  },
  helpTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  helpScroll: {
    maxHeight: 400,
  },
  helpScrollContent: {
    padding: 20,
    gap: 8,
  },
  helpSection: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 12,
    marginBottom: 6,
  },
  helpCommand: {
    color: colors.text,
    fontSize: 14,
    paddingVertical: 4,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  helpCloseButton: {
    margin: 20,
    minHeight: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpCloseText: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  // Transfer progress
  transferSection: {
    gap: 6,
    paddingVertical: 4,
  },
  transferItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  transferName: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    width: 80,
  },
  transferBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.panelSoft,
    overflow: 'hidden',
  },
  transferBarFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  transferPct: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
    width: 36,
    textAlign: 'right',
  },
  // ICE dot
  iceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // Avatar picker
  avatarSection: {
    gap: 8,
  },
  avatarRow: {
    gap: 10,
    paddingVertical: 4,
  },
  avatarButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 2,
  },
  avatarButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: '#1a2e3a',
  },
  avatarEmoji: {
    fontSize: 24,
  },
  avatarEmojiSmall: {
    fontSize: 14,
    marginLeft: 4,
  },
  // Status selector
  statusSection: {
    gap: 8,
  },
  statusButton: {
    minHeight: 36,
    borderRadius: 8,
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1,
  },
  statusButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: '#1a2e3a',
  },
  statusBtnText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  statusBtnTextSelected: {
    color: colors.accent,
  },
  // Peer status in room list
  peerStatusText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    fontStyle: 'italic',
  },
});
