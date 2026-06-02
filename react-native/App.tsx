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
  KeyRound,
  Library,
  Link,
  ListPlus,
  MessageCircle,
  MonitorPlay,
  Pause,
  Play,
  Plug,
  Send,
  Settings as SettingsIcon,
  Shuffle,
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
  type ConnectionState,
  type P2PConnectionConfig,
  type FileEntry,
  type PeerState,
  type RoomStateSnapshot,
  type SyncEvent,
} from './src/syncplay/connectionV2';
import { parseTimestamp } from './src/syncplay/playback';
import {
  assetToMediaLibraryItem,
  formatBytes,
  formatClockTime,
  formatTime,
  parseSlashCommand,
  shuffleFiles,
} from './src/app/appHelpers';
import { scanMediaDirectory } from './src/app/directoryScanner';
import {
  PREFERENCES_STORAGE_KEY,
  createPersistedPreferences,
  parsePersistedPreferences,
  serializePersistedPreferences,
  type LoopMode
} from './src/app/preferences';
import { resolvePlaylistItem } from './src/app/playlistPlayback';
import { calculateSyncCorrection } from './src/app/syncControl';
import { ErrorBoundary } from './src/app/ErrorBoundary';
import {
  addMediaItems,
  buildDirectoryLabels,
  findMediaByName,
  type MediaLibraryItem
} from './src/syncplay/mediaLibrary';
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

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Room state (synced from P2P)
  const [playstate, setPlaystate] = useState<{ position: number; paused: boolean; setBy: string; speed: number }>({
    position: 0, paused: true, setBy: '', speed: 1.0,
  });
  const [playlist, setPlaylist] = useState<{ files: string[]; index: number }>({ files: [], index: 0 });
  const [roomPeers, setRoomPeers] = useState<PeerState[]>([]);

  // Chat messages
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Form & local UI
  const [form, setForm] = useState(defaultForm);
  const [chatDraft, setChatDraft] = useState('');
  const [mediaUri, setMediaUri] = useState<string | null>(null);
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

  // Refs
  const lastSentPositionRef = useRef(0);
  const previousSeekPositionRef = useRef<number | null>(null);
  const lastConnectionConfigRef = useRef<P2PConnectionConfig | null>(null);
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedPlaylistKeyRef = useRef<string | null>(null);
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

  const connection = useMemo(() => {
    const conn = new P2PConnection(form.username);
    // Subscribe to state manager events
    conn.stateManager.onSyncEvent((event: SyncEvent) => {
      handleSyncEvent(event, conn);
    });
    return conn;
  }, []);

  // Keep username ref in sync
  useEffect(() => {
    usernameRef.current = form.username;
  }, [form.username]);

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

  useEffect(() => {
    if (!preferencesLoaded) return;
    const prefs = createPersistedPreferences({
      form: form as unknown as Parameters<typeof createPersistedPreferences>[0]['form'],
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

  // ── Auto-reconnect ──────────────────────────────────────────────────────

  useEffect(() => {
    if (connectionState !== 'error' && connectionState !== 'offline') return;
    if (!autoReconnect || manualDisconnectRef.current || !lastConnectionConfigRef.current) return;
    if (reconnectTimerRef.current) return;

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const config = lastConnectionConfigRef.current;
      if (config && autoReconnect && !manualDisconnectRef.current) {
        connection.connect(config).catch(err => {
          setConnectionError(String(err));
        });
      }
    }, 2500);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [autoReconnect, connection, connectionState]);

  // ── Sync correction ─────────────────────────────────────────────────────

  useEffect(() => {
    const correction = calculateSyncCorrection({
      hasMedia: !!media,
      syncPaused,
      localPosition: player.currentTime,
      remotePosition: playstate.position,
      remotePaused: playstate.paused,
      localPlaying: player.playing,
      doSeek: playstate.setBy !== '' && playstate.setBy !== form.username,
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

    const config: P2PConnectionConfig = {
      signalingUrl: `ws://${host}:8998`,
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
    connection.disconnect();
    setConnectionState('offline');
    setConnectionError(null);
    setRoomPeers([]);
  }

  async function pickMedia() {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'video/*',
      copyToCacheDirectory: false,
      multiple: false
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const item = rememberMediaAssets([asset])[0];
    if (item) loadMediaItem(item);
  }

  async function pickMediaSearchFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'video/*',
      copyToCacheDirectory: false,
      multiple: true
    });

    if (result.canceled || result.assets.length === 0) return;

    const addedItems = rememberMediaAssets(result.assets);
    if (!mediaUri && addedItems[0]) loadMediaItem(addedItems[0]);
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
    const muted = connection.toggleMute();
    setVoiceMuted(muted);
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
    connection.stateManager.addToPlaylist(deduped);
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
        <FlatList
          data={roomPeers}
          keyExtractor={item => item.username}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No peers connected.</Text>}
          renderItem={({ item }) => (
            <View style={styles.userRow}>
              <View style={styles.userAvatar}>
                <Text style={styles.userInitial}>{item.username.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.userMain}>
                <Text style={styles.userName}>
                  {item.username}
                  {item.username === form.username ? ' (you)' : ''}
                  {item.isHost ? ' · host' : ''}
                  {item.isController ? ' · controller' : ''}
                </Text>
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
          )}
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

  return (
    <ErrorBoundary>
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
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
            <View style={[styles.statusDot, connected ? styles.dotLive : styles.dotIdle]} />
          </View>

          {screenContent}
        </ScrollView>
        <BottomTabs activeScreen={activeScreen} onSelect={setActiveScreen} connected={connected} />
      </KeyboardAvoidingView>
    </SafeAreaView>
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
});
