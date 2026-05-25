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
  KeyRound,
  Link,
  Library,
  ListPlus,
  MessageCircle,
  MonitorPlay,
  Pause,
  Play,
  Plug,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Shuffle,
  Trash2,
  Undo2,
  UserCheck,
  Users
} from 'lucide-react-native';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
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

import { SyncplayConnection, type ConnectionConfig, type PlaybackSnapshot } from './src/syncplay/connection';
import { type SyncplayFile } from './src/syncplay/protocol';
import {
  createInitialSyncplayState,
  syncplayReducer,
  type RoomUser,
  type SyncplayMessage
} from './src/syncplay/state';
import {
  PUBLIC_SERVER_OPTIONS,
  formatServerAddress,
  parseServerAddress
} from './src/syncplay/servers';
import { generateManagedRoomPassword, normalizeManagedRoomPassword } from './src/syncplay/managedRooms';
import { parseTimestamp } from './src/syncplay/playback';
import {
  assetToMediaLibraryItem,
  formatBytes,
  formatTime,
  getTransferDisplay,
  isManagedRoomName,
  shouldAnnounceMediaOnConnection,
  shuffleFiles,
  statusLabel,
  stripManagedRoomName
} from './src/app/appHelpers';
import { scanMediaDirectory } from './src/app/directoryScanner';
import { createExpoTransferSink, createExpoTransferSource } from './src/app/fileTransferSink';
import {
  PREFERENCES_STORAGE_KEY,
  createPersistedPreferences,
  parsePersistedPreferences,
  serializePersistedPreferences
} from './src/app/preferences';
import { resolvePlaylistItem } from './src/app/playlistPlayback';
import { calculateSyncCorrection } from './src/app/syncControl';
import {
  addRoomToSavedList,
  buildRoomOptions,
  filterVisibleRooms,
  parseRoomEntry,
  resolveJoinRoomEntry
} from './src/syncplay/rooms';
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

type ConnectionForm = {
  serverAddress: string;
  username: string;
  room: string;
  password: string;
  useTls: boolean;
};
type ConnectionTextField = Exclude<keyof ConnectionForm, 'useTls'>;

const defaultForm: ConnectionForm = {
  serverAddress: 'syncplay.pl:8999',
  username: 'Mobile',
  room: 'default',
  password: '',
  useTls: false
};

export default function App() {
  const [state, dispatch] = useReducer(syncplayReducer, undefined, createInitialSyncplayState);
  const [form, setForm] = useState(defaultForm);
  const [chatDraft, setChatDraft] = useState('');
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibraryItem[]>([]);
  const [transferDirectory, setTransferDirectory] = useState<Directory | null>(null);
  const [streamUrl, setStreamUrl] = useState('');
  const [seekDraft, setSeekDraft] = useState('0:00');
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [managedRoomName, setManagedRoomName] = useState('');
  const [operatorPassword, setOperatorPassword] = useState('');
  const [savedRooms, setSavedRooms] = useState<string[]>(['default']);
  const [roomListDraft, setRoomListDraft] = useState('default');
  const [autosaveJoinedRooms, setAutosaveJoinedRooms] = useState(true);
  const [hideEmptyRooms, setHideEmptyRooms] = useState(false);
  const [controlPasswords, setControlPasswords] = useState<Record<string, string>>({});
  const [isReady, setIsReady] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [autoFileSwitch, setAutoFileSwitch] = useState(true);
  const [keepPlayingInBackground, setKeepPlayingInBackground] = useState(true);
  const [missingMediaName, setMissingMediaName] = useState<string | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [activeScreen, setActiveScreen] = useState<AppScreenId>(getInitialScreen(false));
  const playbackRef = useRef<PlaybackSnapshot>({ position: null, paused: true });
  const lastSentPositionRef = useRef(0);
  const previousSeekPositionRef = useRef<number | null>(null);
  const lastConnectionConfigRef = useRef<ConnectionConfig | null>(null);
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedPlaylistKeyRef = useRef<string | null>(null);
  const lastAutoFileSwitchRef = useRef<string | null>(null);
  const openedTransferSocketsRef = useRef<Map<string, string>>(new Map());
  const wasConnectedRef = useRef(false);

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

  const connection = useMemo(
    () =>
      new SyncplayConnection(
        (status, error) =>
          dispatch({
            type: 'connection-status',
            status,
            ...(error === undefined ? {} : { error })
          }),
        message => dispatch({ type: 'server-message', message }),
        () => playbackRef.current
      ),
    []
  );

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(PREFERENCES_STORAGE_KEY)
      .then(value => {
        if (!alive) {
          return;
        }

        const preferences = parsePersistedPreferences(value);
        if (preferences) {
          setForm(preferences.form);
          setSavedRooms(preferences.savedRooms.length ? preferences.savedRooms : ['default']);
          setMediaLibrary(preferences.mediaLibrary);
          setControlPasswords(preferences.controlPasswords);
          setAutosaveJoinedRooms(preferences.autosaveJoinedRooms);
          setHideEmptyRooms(preferences.hideEmptyRooms);
          setSyncPaused(preferences.syncPaused);
          setAutoReconnect(preferences.autoReconnect);
          setAutoFileSwitch(preferences.autoFileSwitch);
          setKeepPlayingInBackground(preferences.keepPlayingInBackground);
        }
      })
      .finally(() => {
        if (alive) {
          setPreferencesLoaded(true);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) {
      return;
    }

    const preferences = createPersistedPreferences({
      form,
      savedRooms,
      mediaLibrary,
      controlPasswords,
      autosaveJoinedRooms,
      hideEmptyRooms,
      syncPaused,
      autoReconnect,
      autoFileSwitch,
      keepPlayingInBackground
    });
    AsyncStorage.setItem(PREFERENCES_STORAGE_KEY, serializePersistedPreferences(preferences));
  }, [
    autosaveJoinedRooms,
    autoFileSwitch,
    autoReconnect,
    controlPasswords,
    form,
    hideEmptyRooms,
    keepPlayingInBackground,
    mediaLibrary,
    preferencesLoaded,
    savedRooms,
    syncPaused
  ]);

  useEffect(() => {
    player.staysActiveInBackground = keepPlayingInBackground;
  }, [keepPlayingInBackground, player]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' && state.media) {
        connection.sendPlayback(player.currentTime, !player.playing, true);
        if (!keepPlayingInBackground && player.playing) {
          player.pause();
        }
      }
    });

    return () => subscription.remove();
  }, [connection, keepPlayingInBackground, player, state.media]);

  useEffect(() => {
    if (state.connection.status !== 'error' && state.connection.status !== 'disconnected') {
      return;
    }
    if (!autoReconnect || manualDisconnectRef.current || !lastConnectionConfigRef.current) {
      return;
    }
    if (reconnectTimerRef.current) {
      return;
    }

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const config = lastConnectionConfigRef.current;
      if (config && autoReconnect && !manualDisconnectRef.current) {
        connection.connect(config);
      }
    }, 2500);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [autoReconnect, connection, state.connection.status]);

  useEffect(() => {
    playbackRef.current = {
      position: state.media ? player.currentTime : null,
      paused: state.media ? !player.playing : true
    };
  }, [player, state.media, playingEvent.isPlaying, timeEvent.currentTime]);

  useEffect(() => {
    if (!state.media) {
      return;
    }

    dispatch({
      type: 'local-playback-updated',
      position: timeEvent.currentTime,
      paused: !playingEvent.isPlaying
    });

    const jump = Math.abs(timeEvent.currentTime - lastSentPositionRef.current);
    if (jump > 1.5) {
      connection.sendPlayback(timeEvent.currentTime, !playingEvent.isPlaying, true);
    }
    lastSentPositionRef.current = timeEvent.currentTime;
  }, [connection, playingEvent.isPlaying, state.media, timeEvent.currentTime]);

  useEffect(() => {
    const correction = calculateSyncCorrection({
      hasMedia: !!state.media,
      syncPaused,
      localPosition: player.currentTime,
      remotePosition: state.playback.position,
      remotePaused: state.playback.paused,
      localPlaying: player.playing,
      doSeek: state.playback.doSeek
    });

    player.playbackRate = correction.rate;
    if (typeof correction.seekTo === 'number') {
      player.currentTime = correction.seekTo;
    }

    if (correction.shouldPause) {
      player.pause();
    } else if (correction.shouldPlay) {
      player.play();
    }
  }, [
    player,
    state.media,
    state.playback.doSeek,
    state.playback.paused,
    state.playback.position,
    syncPaused
  ]);

  useEventListener(player, 'playingChange', event => {
    if (!state.media) {
      return;
    }

    connection.sendPlayback(player.currentTime, !event.isPlaying, false);
  });

  useEventListener(player, 'sourceLoad', event => {
    if (!state.media) {
      return;
    }

    const media = {
      ...state.media,
      duration: Math.round(event.duration || state.media.duration)
    };
    dispatch({ type: 'media-updated', media });
    connection.sendFile(media);
  });

  const roomUsers = state.rooms[state.profile.room] ?? [];
  const transfers = Object.values(state.transfers);
  const connected = state.connection.status === 'connected';
  const currentRoomUser = roomUsers.find(user => user.username === state.profile.username);
  const canControlRoom =
    !isManagedRoomName(state.profile.room) ||
    currentRoomUser?.isController === true ||
    state.managedRoom.controllerRooms[state.profile.room] === state.profile.username;
  const visibleRoomNames = filterVisibleRooms(state.rooms, hideEmptyRooms);
  const roomOptions = buildRoomOptions(savedRooms, visibleRoomNames);
  const mediaDirectoryLabels = buildDirectoryLabels(mediaLibrary);

  useEffect(() => {
    if (shouldAnnounceMediaOnConnection(wasConnectedRef.current, connected, state.media)) {
      connection.sendFile(state.media);
    }
    wasConnectedRef.current = connected;
  }, [connected, connection, state.media]);

  useEffect(() => {
    const index = state.playlist.index;
    const item = typeof index === 'number' ? state.playlist.files[index] : null;
    if (!item || state.playlist.updatedBy === state.profile.username) {
      return;
    }

    const applyKey = `${index}:${item}:${state.playlist.updatedBy ?? ''}`;
    if (lastAppliedPlaylistKeyRef.current === applyKey) {
      return;
    }
    lastAppliedPlaylistKeyRef.current = applyKey;
    openPlaylistItem(item);
  }, [
    mediaLibrary,
    state.playlist.files,
    state.playlist.index,
    state.playlist.updatedBy,
    state.profile.username
  ]);

  useEffect(() => {
    if (!connected || !autoFileSwitch || mediaLibrary.length === 0) {
      return;
    }

    const candidate = roomUsers.find(user => {
      if (user.username === state.profile.username || !user.file?.name) {
        return false;
      }
      if (state.media?.name === user.file.name) {
        return false;
      }
      return Boolean(findMediaByName(mediaLibrary, user.file.name));
    });

    if (!candidate?.file?.name || lastAutoFileSwitchRef.current === candidate.file.name) {
      return;
    }

    lastAutoFileSwitchRef.current = candidate.file.name;
    openLibraryFileByName(candidate.file.name);
  }, [autoFileSwitch, connected, mediaLibrary, roomUsers, state.media?.name, state.profile.username]);

  useEffect(() => {
    if (!connected) {
      openedTransferSocketsRef.current.clear();
      return;
    }

    for (const transfer of transfers) {
      if (transfer.status !== 'approved') {
        openedTransferSocketsRef.current.delete(transfer.transferId);
      }
      if (
        transfer.status !== 'approved' ||
        !transfer.token ||
        openedTransferSocketsRef.current.get(transfer.transferId) === transfer.token
      ) {
        continue;
      }
      if (transfer.role === 'receiver') {
        openedTransferSocketsRef.current.set(transfer.transferId, transfer.token);
        const sink = createExpoTransferSink(transfer.transferId, transfer.file?.name ?? transfer.transferId, transferDirectory ?? undefined);
        connection.openTransferSocket(
          {
            transferId: transfer.transferId,
            token: transfer.token,
            role: 'receiver',
            offset: sink.getOffset()
          },
          sink,
          completedPath => {
            openedTransferSocketsRef.current.delete(transfer.transferId);
            dispatch({ type: 'transfer-completed', transferId: transfer.transferId, completedPath });
          },
          undefined,
          undefined,
          error => {
            openedTransferSocketsRef.current.delete(transfer.transferId);
            dispatch({ type: 'transfer-failed', transferId: transfer.transferId, error: error.message });
          }
        );
      } else if (transfer.role === 'sender') {
        const sourceItem = findMediaByName(mediaLibrary, transfer.file?.name ?? state.media?.name);
        if (!sourceItem) {
          continue;
        }
        openedTransferSocketsRef.current.set(transfer.transferId, transfer.token);
        connection.openTransferSocket(
          {
            transferId: transfer.transferId,
            token: transfer.token,
            role: 'sender',
            offset: transfer.offset
          },
          { write: () => undefined },
          undefined,
          createExpoTransferSource(sourceItem.uri),
          undefined,
          error => {
            openedTransferSocketsRef.current.delete(transfer.transferId);
            dispatch({ type: 'transfer-failed', transferId: transfer.transferId, error: error.message });
          }
        );
      }
    }
  }, [connected, connection, mediaLibrary, state.media?.name, transferDirectory, transfers]);

  useEffect(() => {
    if (connected && activeScreen === 'connect') {
      setActiveScreen('watch');
    } else if (!connected && activeScreen !== 'connect') {
      setActiveScreen('connect');
    }
  }, [activeScreen, connected]);

  useEffect(() => {
    setRoomListDraft(savedRooms.join('\n'));
  }, [savedRooms]);

  function updateForm(key: ConnectionTextField, value: string) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function connect() {
    const server = parseServerAddress(form.serverAddress);
    if (!server) {
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: 'Enter a server as host:port.'
      });
      return;
    }

    dispatch({
      type: 'profile-updated',
      username: form.username.trim() || 'Mobile',
      room: form.room.trim() || 'default'
    });
    const config = {
      host: server.host,
      port: server.port,
      username: form.username.trim() || 'Mobile',
      room: form.room.trim() || 'default',
      tls: form.useTls,
      ...(form.password.trim() ? { password: form.password.trim() } : {})
    };
    manualDisconnectRef.current = false;
    lastConnectionConfigRef.current = config;
    updateForm('serverAddress', formatServerAddress(server));
    connection.connect(config);
  }

  function disconnect() {
    manualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connection.disconnect();
    dispatch({ type: 'connection-status', status: 'disconnected' });
  }

  async function pickMedia() {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'video/*',
      copyToCacheDirectory: false,
      multiple: false
    });

    if (result.canceled || !result.assets[0]) {
      return;
    }

    const asset = result.assets[0];
    const item = rememberMediaAssets([asset])[0];
    if (item) {
      loadMediaItem(item);
    }
  }

  async function pickMediaSearchFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'video/*',
      copyToCacheDirectory: false,
      multiple: true
    });

    if (result.canceled || result.assets.length === 0) {
      return;
    }

    const addedItems = rememberMediaAssets(result.assets);
    if (!mediaUri && addedItems[0]) {
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
        dispatch({
          type: 'connection-status',
          status: 'error',
          error: 'No supported video files found in that folder.'
        });
        return;
      }

      const nextItems = addMediaItems(mediaLibrary, scannedItems);
      setMediaLibrary(nextItems);
      if (!mediaUri) {
        const firstItem = nextItems.find(item => item.uri === scannedItems[0]?.uri);
        if (firstItem) {
          loadMediaItem(firstItem);
        }
      }
      setMissingMediaName(null);
    } catch (error) {
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not read that folder.'
      });
    }
  }

  async function pickTransferDirectory() {
    try {
      const directory = await Directory.pickDirectoryAsync();
      setTransferDirectory(directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not select download folder.';
      dispatch({ type: 'connection-status', status: 'error', error: message });
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
    const media: SyncplayFile = {
      name: item.name,
      duration: item.duration ?? 0,
      size: item.size
    };

    setMediaUri(item.uri);
    setMissingMediaName(null);
    dispatch({ type: 'media-updated', media });
    if (connected) {
      connection.sendFile(media);
    }
  }

  function openLibraryFileByName(filename: string | null) {
    const item = findMediaByName(mediaLibrary, filename);
    if (!item) {
      return;
    }

    loadMediaItem(item);
  }

  function openStream() {
    const url = streamUrl.trim();
    if (!url) {
      return;
    }

    openStreamUri(url);
    setStreamUrl('');
  }

  function openStreamUri(url: string) {
    const media: SyncplayFile = {
      name: url,
      duration: 0,
      size: 0
    };

    setMediaUri(url);
    setMissingMediaName(null);
    dispatch({ type: 'media-updated', media });
    if (connected) {
      connection.sendFile(media);
    }
  }

  function sendChat() {
    connection.sendChat(chatDraft);
    setChatDraft('');
  }

  function changeRoom() {
    joinRoomEntry(form.room);
  }

  function joinRoomEntry(entry: string) {
    const resolvedEntry = resolveJoinRoomEntry(entry, state.media?.name ?? null, 'default');
    const parsed = parseRoomEntry(resolvedEntry);
    if (!parsed.room) {
      return;
    }

    const password = parsed.password ?? controlPasswords[parsed.room] ?? null;
    if (parsed.password) {
      setControlPasswords(current => ({ ...current, [parsed.room]: parsed.password as string }));
      setOperatorPassword(parsed.password);
    }

    updateForm('room', parsed.room);
    dispatch({
      type: 'profile-updated',
      username: state.profile.username,
      room: parsed.room
    });
    connection.sendRoom(parsed.room);
    if (password) {
      connection.requestControlledRoom(parsed.room, password);
    }
    if (autosaveJoinedRooms) {
      setSavedRooms(current => addRoomToSavedList(current, parsed.listValue));
    }
    setManagedRoomName(stripManagedRoomName(parsed.room));
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
    setSavedRooms(current => addRoomToSavedList(current, form.room));
    setRoomListDraft(current => addRoomToSavedList(current.split(/\r?\n/), form.room).join('\n'));
  }

  function toggleReady() {
    const next = !isReady;
    setIsReady(next);
    connection.sendReady(next);
  }

  function togglePlayback() {
    if (player.playing) {
      player.pause();
    } else {
      player.play();
    }
  }

  function seekFromInput() {
    const nextPosition = parseTimestamp(seekDraft);
    if (nextPosition === null) {
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: 'Enter a time like 1:23 or 1:02:03.'
      });
      return;
    }

    previousSeekPositionRef.current = player.currentTime;
    player.currentTime = nextPosition;
    connection.sendPlayback(nextPosition, !player.playing, true);
  }

  function undoSeek() {
    const previousPosition = previousSeekPositionRef.current;
    if (previousPosition === null) {
      return;
    }

    previousSeekPositionRef.current = player.currentTime;
    player.currentTime = previousPosition;
    setSeekDraft(formatTime(previousPosition));
    connection.sendPlayback(previousPosition, !player.playing, true);
  }

  function addCurrentMediaToPlaylist() {
    if (state.media?.name) {
      sendPlaylist([...state.playlist.files, state.media.name]);
    }
  }

  function addPlaylistUrl() {
    const url = playlistUrl.trim();
    if (!url) {
      return;
    }

    sendPlaylist([...state.playlist.files, url]);
    setPlaylistUrl('');
  }

  function clearPlaylist() {
    sendPlaylist([]);
  }

  function shufflePlaylist() {
    sendPlaylist(shuffleFiles(state.playlist.files));
  }

  function playPlaylistIndex(index: number) {
    const item = state.playlist.files[index];
    if (!item) {
      return;
    }

    connection.sendPlaylistIndex(index);
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
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: `Could not find ${resolved.filename} in media search.`
      });
    }
  }

  function sendPlaylist(files: string[]) {
    const deduped = Array.from(new Set(files.map(file => file.trim()).filter(Boolean)));
    connection.sendPlaylist(deduped);
  }

  function createManagedRoom() {
    const room = (managedRoomName.trim() || stripManagedRoomName(state.profile.room)).trim();
    if (!room) {
      return;
    }

    const password = generateManagedRoomPassword();
    setOperatorPassword(password);
    connection.requestControlledRoom(room, password);
  }

  function identifyAsController() {
    const password = normalizeManagedRoomPassword(operatorPassword);
    if (!password) {
      return;
    }

    setOperatorPassword(password);
    connection.requestControlledRoom(state.profile.room, password);
  }

  const selectedServerAddress = parseServerAddress(form.serverAddress);
  const selectedServerText = selectedServerAddress ? formatServerAddress(selectedServerAddress) : '';

  const screenContent =
    activeScreen === 'connect' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <Plug color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Connection</Text>
        </View>
        <View style={styles.connectionSummary}>
          <SummaryItem label="Server" value={selectedServerText || form.serverAddress || 'host:port'} />
          <SummaryItem label="Username" value={form.username.trim() || 'Mobile'} />
          <SummaryItem label="Room" value={form.room.trim() || 'default'} />
          <SummaryItem label="Transport" value={form.useTls ? 'TLS' : 'TCP'} />
        </View>
        <Text style={styles.label}>Public servers</Text>
        <View style={styles.serverOptionGrid}>
          {PUBLIC_SERVER_OPTIONS.map(option => {
            const selected = selectedServerText === option.address;
            return (
              <Pressable
                key={option.address}
                style={[styles.serverOption, selected && styles.serverOptionSelected]}
                onPress={() => updateForm('serverAddress', option.address)}
              >
                <Text style={[styles.serverOptionText, selected && styles.serverOptionTextSelected]}>
                  {option.address}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          label="Server address"
          value={form.serverAddress}
          onChangeText={value => updateForm('serverAddress', value)}
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
          label="Server password"
          value={form.password}
          onChangeText={value => updateForm('password', value)}
          secureTextEntry
        />
        <Pressable
          style={[styles.switchPill, form.useTls && styles.switchPillOn]}
          onPress={() => setForm(current => ({ ...current, useTls: !current.useTls }))}
        >
          <Text style={[styles.switchText, form.useTls && styles.switchTextOn]}>
            {form.useTls ? 'TLS on' : 'Plain TCP'}
          </Text>
        </Pressable>
        <View style={styles.buttonRow}>
          <ActionButton
            label={connected ? 'Disconnect' : 'Connect'}
            icon={connected ? DoorOpen : Plug}
            tone={connected ? 'ghost' : 'primary'}
            onPress={connected ? disconnect : connect}
          />
        </View>
        {state.connection.error ? <Text style={styles.errorText}>{state.connection.error}</Text> : null}
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
              {state.media?.name ?? 'No media loaded'}
            </Text>
            <Text style={styles.smallText}>
              {formatTime(timeEvent.currentTime)} / {formatTime(player.duration || 0)}
              {statusEvent.status ? ` · ${statusEvent.status}` : ''}
            </Text>
          </View>
          <Pressable style={styles.secondaryIconButton} onPress={pickMedia}>
            <Film color="#d7e5ef" size={20} />
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
              </Pressable>
            )}
          />
        </View>
      </>
    ) : activeScreen === 'room' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <Users color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>{state.profile.room}</Text>
          <Text style={styles.countText}>{roomUsers.length}</Text>
        </View>
        <FlatList
          data={roomUsers}
          keyExtractor={item => item.username}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No room list yet.</Text>}
          renderItem={({ item }) => (
            <UserRow
              user={item}
              currentUser={state.profile.username}
              canSetReady={connected && canControlRoom}
              onSetReady={nextReady => connection.sendUserReady(item.username, nextReady)}
              canOpenFile={Boolean(item.file?.name && findMediaByName(mediaLibrary, item.file.name))}
              onOpenFile={() => openLibraryFileByName(item.file?.name ?? null)}
              canRequestDownload={Boolean(
                connected &&
                  state.server.features.fileTransfer &&
                  item.username !== state.profile.username &&
                  item.file?.name
              )}
              onRequestDownload={() => connection.requestTransfer(item.username)}
            />
          )}
        />
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <Users color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Join Room</Text>
        </View>
        <View style={styles.inlineRow}>
          <Field label="Room" value={form.room} onChangeText={value => updateForm('room', value)} />
          <ActionButton label="Join" icon={Users} tone="ghost" onPress={changeRoom} disabled={!connected} />
        </View>
        <View style={styles.serverOptionGrid}>
          {roomOptions.map(room => (
            <Pressable
              key={room}
              style={[styles.serverOption, form.room === parseRoomEntry(room).room && styles.serverOptionSelected]}
              onPress={() => joinRoomEntry(room)}
              disabled={!connected}
            >
              <Text
                style={[
                  styles.serverOptionText,
                  form.room === parseRoomEntry(room).room && styles.serverOptionTextSelected
                ]}
                numberOfLines={1}
              >
                {room}
              </Text>
            </Pressable>
          ))}
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
          <Pressable
            style={[styles.switchPill, hideEmptyRooms && styles.switchPillOn]}
            onPress={() => setHideEmptyRooms(value => !value)}
          >
            <Text style={[styles.switchText, hideEmptyRooms && styles.switchTextOn]}>
              {hideEmptyRooms ? 'Hiding empty' : 'Showing empty'}
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
          <Text style={styles.countText}>{state.playlist.files.length}</Text>
        </View>
        <FlatList
          data={state.playlist.files}
          keyExtractor={(item, index) => `${item}-${index}`}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No playlist yet.</Text>}
          renderItem={({ item, index }) => (
            <Pressable
              style={[styles.playlistRow, state.playlist.index === index && styles.playlistRowActive]}
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
            disabled={!connected || !state.media}
          />
          <ActionButton
            label="Shuffle"
            icon={Shuffle}
            tone="ghost"
            onPress={shufflePlaylist}
            disabled={!connected || state.playlist.files.length < 2}
          />
          <ActionButton
            label="Clear"
            icon={Trash2}
            tone="ghost"
            onPress={clearPlaylist}
            disabled={!connected || state.playlist.files.length === 0}
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.panelTitleRow}>
          <ShieldCheck color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Managed Room</Text>
        </View>
        <View style={styles.inlineRow}>
          <Field label="Room" value={managedRoomName} onChangeText={setManagedRoomName} />
          <ActionButton
            label="Create"
            icon={ShieldCheck}
            tone="ghost"
            onPress={createManagedRoom}
            disabled={!connected}
          />
        </View>
        <View style={styles.inlineRow}>
          <Field
            label="Operator password"
            value={operatorPassword}
            onChangeText={setOperatorPassword}
            autoCapitalize="characters"
          />
          <ActionButton
            label="Identify"
            icon={KeyRound}
            tone="ghost"
            onPress={identifyAsController}
            disabled={!connected}
          />
        </View>
      </View>
    ) : activeScreen === 'transfers' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <Download color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Transfers</Text>
          <Text style={styles.countText}>{transfers.length}</Text>
          <ActionButton label="Folder" icon={FolderOpen} tone="ghost" onPress={pickTransferDirectory} />
        </View>
        <FlatList
          data={transfers}
          keyExtractor={item => item.transferId}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>No transfers yet.</Text>}
          renderItem={({ item }) => {
            const display = getTransferDisplay(item);
            const retryOffset = Math.max(item.transferred, item.offset);
            const canResume = item.status.startsWith('paused') && display.canRetry;
            const canRetry = item.status === 'failed' && display.canRetry;
            const canCancel = !['incoming-request', 'complete', 'cancelled'].includes(item.status);

            return (
              <View style={styles.transferRow}>
                <View style={styles.transferHeader}>
                  <Download color={item.status === 'failed' ? colors.error : colors.accent} size={17} />
                  <View style={styles.transferTitleBlock}>
                    <Text style={styles.playlistText} numberOfLines={1}>
                      {item.file?.name ?? item.transferId}
                    </Text>
                    <Text style={styles.transferDetail} numberOfLines={2}>
                      {display.detail}
                    </Text>
                  </View>
                  <View style={[styles.transferStatusBadge, item.status === 'failed' && styles.transferStatusBadgeError]}>
                    <Text style={[styles.transferStatusText, item.status === 'failed' && styles.transferStatusTextError]}>
                      {display.label}
                    </Text>
                  </View>
                </View>
                {item.status !== 'incoming-request' ? (
                  <View style={styles.transferProgressTrack}>
                    <View style={[styles.transferProgressFill, { width: `${Math.round(display.progress * 100)}%` }]} />
                  </View>
                ) : null}
                <View style={styles.transferFooter}>
                  <Text style={styles.smallText}>
                    {item.role === 'sender' ? 'Sending' : 'Receiving'} {item.size ? `· ${formatBytes(item.size)}` : ''}
                  </Text>
                  <View style={styles.transferActions}>
                    {item.status === 'downloading' ? (
                      <Pressable
                        style={styles.transferIconButton}
                        accessibilityLabel="Pause transfer"
                        onPress={() => connection.pauseTransfer(item.transferId, item.role ?? 'receiver')}
                      >
                        <Pause color="#d7e5ef" size={16} />
                      </Pressable>
                    ) : null}
                    {item.status === 'incoming-request' ? (
                      <Pressable
                        style={styles.transferIconButton}
                        accessibilityLabel="Accept transfer"
                        onPress={() => {
                          const sourceItem = findMediaByName(mediaLibrary, item.file?.name ?? state.media?.name);
                          if (sourceItem) {
                            connection.sendTransferDecision({ transferId: item.transferId, accepted: true });
                          } else {
                            connection.sendTransferDecision({ transferId: item.transferId, accepted: false, reason: 'missing-local-media' });
                          }
                        }}
                      >
                        <Check color="#d7e5ef" size={16} />
                      </Pressable>
                    ) : null}
                    {item.status === 'incoming-request' ? (
                      <Pressable
                        style={styles.transferIconButton}
                        accessibilityLabel="Reject transfer"
                        onPress={() => connection.sendTransferDecision({ transferId: item.transferId, accepted: false, reason: 'rejected' })}
                      >
                        <Trash2 color="#d7e5ef" size={16} />
                      </Pressable>
                    ) : null}
                    {canResume ? (
                      <Pressable
                        style={styles.transferActionButton}
                        accessibilityLabel="Resume transfer"
                        onPress={() => connection.resumeTransfer(item.transferId, retryOffset, item.fingerprint)}
                      >
                        <Play color="#d7e5ef" size={15} />
                        <Text style={styles.transferActionText}>Resume</Text>
                      </Pressable>
                    ) : null}
                    {canRetry ? (
                      <Pressable
                        style={styles.transferActionButton}
                        accessibilityLabel="Retry transfer"
                        onPress={() => dispatch({ type: 'transfer-retry', transferId: item.transferId })}
                      >
                        <Undo2 color="#d7e5ef" size={15} />
                        <Text style={styles.transferActionText}>Retry</Text>
                      </Pressable>
                    ) : null}
                    {canCancel ? (
                      <Pressable
                        style={styles.transferIconButton}
                        accessibilityLabel="Cancel transfer"
                        onPress={() => connection.cancelTransfer(item.transferId, item.role ?? 'receiver')}
                      >
                        <Trash2 color="#d7e5ef" size={16} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          }}
        />
      </View>
    ) : activeScreen === 'chat' ? (
      <View style={styles.panel}>
        <View style={styles.panelTitleRow}>
          <MessageCircle color="#7fd2ff" size={18} />
          <Text style={styles.panelTitle}>Chat</Text>
        </View>
        <FlatList
          data={state.messages}
          keyExtractor={item => item.id}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.mutedText}>Messages will appear here.</Text>}
          renderItem={({ item }) => <MessageRow message={item} />}
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
            <Text style={styles.userName}>Current connection</Text>
            <Text style={styles.smallText}>
              {form.serverAddress} · {state.profile.username} · {state.profile.room}
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
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({ ios: 'padding', android: undefined })}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View>
              <Text style={styles.brand}>Syncplay Mobile</Text>
              <Text style={styles.screenTitle}>{getScreenTitle(activeScreen)}</Text>
              <Text style={styles.statusText}>
                {statusLabel(state.connection.status)}
                {state.server.version ? ` · server ${state.server.version}` : ''}
              </Text>
            </View>
            <View style={[styles.statusDot, connected ? styles.dotLive : styles.dotIdle]} />
          </View>

          {screenContent}
        </ScrollView>
        <BottomTabs activeScreen={activeScreen} onSelect={setActiveScreen} connected={connected} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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
  icon: typeof Plug;
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
      <Icon color={tone === 'primary' ? '#061015' : '#d7e5ef'} size={17} />
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
  return (
    <View style={styles.bottomTabs}>
      {APP_SCREENS.map(screen => {
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
    case 'connect':
      return <Plug color={color} size={17} />;
    case 'watch':
      return <Film color={color} size={17} />;
  case 'room':
      return <Users color={color} size={17} />;
    case 'transfers':
      return <Download color={color} size={17} />;
    case 'chat':
      return <MessageCircle color={color} size={17} />;
    case 'settings':
      return <SettingsIcon color={color} size={17} />;
    default:
      return null;
  }
}

function UserRow({
  user,
  currentUser,
  canSetReady,
  onSetReady,
  canOpenFile,
  onOpenFile,
  canRequestDownload,
  onRequestDownload
}: {
  user: RoomUser;
  currentUser: string;
  canSetReady: boolean;
  onSetReady: (nextReady: boolean) => void;
  canOpenFile: boolean;
  onOpenFile: () => void;
  canRequestDownload: boolean;
  onRequestDownload: () => void;
}) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userAvatar}>
        <Text style={styles.userInitial}>{user.username.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.userMain}>
        <Text style={styles.userName}>
          {user.username}
          {user.username === currentUser ? ' (you)' : ''}
        </Text>
        <Text style={styles.smallText} numberOfLines={1}>
          {user.file?.name ?? 'No file'} {user.file ? `· ${formatBytes(user.file.size)}` : ''}
        </Text>
      </View>
      <View style={[styles.readyBadge, user.isReady && styles.readyBadgeOn]}>
        <Text style={[styles.readyText, user.isReady && styles.readyTextOn]}>
          {user.isReady ? 'Ready' : 'Wait'}
        </Text>
      </View>
      {canSetReady ? (
        <Pressable style={styles.userReadyButton} onPress={() => onSetReady(!user.isReady)}>
          <UserCheck color="#d7e5ef" size={16} />
        </Pressable>
      ) : null}
      {canOpenFile ? (
        <Pressable style={styles.userReadyButton} onPress={onOpenFile}>
          <Film color="#d7e5ef" size={16} />
        </Pressable>
      ) : null}
      {canRequestDownload ? (
        <Pressable style={styles.userReadyButton} onPress={onRequestDownload}>
          <Download color="#d7e5ef" size={16} />
        </Pressable>
      ) : null}
    </View>
  );
}

function MessageRow({ message }: { message: SyncplayMessage }) {
  const isChat = message.kind === 'chat';
  return (
    <View style={styles.messageRow}>
      <Text style={isChat ? styles.messageUser : styles.messageKind}>
        {isChat ? message.username : message.kind}
      </Text>
      <Text style={styles.messageText}>{message.text}</Text>
    </View>
  );
}

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
  safe: {
    flex: 1,
    backgroundColor: colors.bg
  },
  container: {
    flex: 1
  },
  content: {
    padding: 16,
    gap: 14
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8
  },
  brand: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0
  },
  screenTitle: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 6
  },
  statusText: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4
  },
  statusDot: {
    width: 14,
    height: 14,
    borderRadius: 7
  },
  dotLive: {
    backgroundColor: colors.green
  },
  dotIdle: {
    backgroundColor: colors.faint
  },
  videoShell: {
    minHeight: 210,
    borderRadius: 8,
    backgroundColor: '#020608',
    overflow: 'hidden',
    borderColor: colors.line,
    borderWidth: 1
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9
  },
  emptyVideo: {
    minHeight: 210,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 12
  },
  emptyCopy: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center'
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.panel
  },
  roundButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent
  },
  transportMeta: {
    flex: 1,
    minWidth: 0
  },
  mediaName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700'
  },
  secondaryIconButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  panel: {
    borderRadius: 8,
    padding: 14,
    gap: 12,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1
  },
  panelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  panelTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    flex: 1
  },
  connectionSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  summaryItem: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 54,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    justifyContent: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1
  },
  summaryLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '800'
  },
  summaryValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4
  },
  countText: {
    color: colors.muted,
    fontSize: 13
  },
  gridTwo: {
    flexDirection: 'row',
    gap: 10
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10
  },
  divider: {
    height: 1,
    backgroundColor: colors.line,
    marginVertical: 2
  },
  serverOptionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  serverOption: {
    minHeight: 38,
    borderRadius: 8,
    paddingHorizontal: 11,
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  serverOptionSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  serverOptionText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800'
  },
  serverOptionTextSelected: {
    color: colors.ink
  },
  field: {
    flex: 1,
    gap: 6
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700'
  },
  input: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1
  },
  textArea: {
    minHeight: 88,
    paddingTop: 10,
    textAlignVertical: 'top'
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10
  },
  actionButton: {
    minHeight: 42,
    borderRadius: 8,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  primaryButton: {
    backgroundColor: colors.accent
  },
  ghostButton: {
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  disabledButton: {
    opacity: 0.45
  },
  actionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  primaryActionText: {
    color: colors.ink
  },
  switchPill: {
    minHeight: 42,
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  switchPillOn: {
    backgroundColor: '#283222',
    borderColor: '#557047'
  },
  switchText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  switchTextOn: {
    color: colors.green
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  settingText: {
    flex: 1,
    minWidth: 0
  },
  bottomTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.select({ ios: 22, android: 12, default: 12 }),
    backgroundColor: colors.bg,
    borderTopColor: colors.line,
    borderTopWidth: 1
  },
  tabButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1
  },
  tabButtonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  tabText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '800'
  },
  tabTextActive: {
    color: colors.ink
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  userAvatar: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#243847'
  },
  userInitial: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800'
  },
  userMain: {
    flex: 1,
    minWidth: 0
  },
  userName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  readyBadge: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: '#1c2830'
  },
  readyBadgeOn: {
    backgroundColor: '#2c4028'
  },
  readyText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800'
  },
  readyTextOn: {
    color: colors.green
  },
  userReadyButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  transferRow: {
    gap: 9,
    paddingVertical: 11,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  transferHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  transferTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  transferDetail: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16
  },
  transferStatusBadge: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: '#1c2830'
  },
  transferStatusBadgeError: {
    backgroundColor: '#3b2527'
  },
  transferStatusText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800'
  },
  transferStatusTextError: {
    color: colors.error
  },
  transferProgressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.bg
  },
  transferProgressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent
  },
  transferFooter: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  transferActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  transferIconButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  transferActionButton: {
    minHeight: 34,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.panelSoft,
    borderColor: colors.line,
    borderWidth: 1
  },
  transferActionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800'
  },
  playlistRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  playlistRowActive: {
    backgroundColor: colors.panelSoft
  },
  playlistIndex: {
    width: 24,
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center'
  },
  playlistText: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700'
  },
  mediaLibraryRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  messageRow: {
    paddingVertical: 8,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  messageUser: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800'
  },
  messageKind: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase'
  },
  messageText: {
    color: colors.text,
    fontSize: 14,
    marginTop: 2
  },
  chatInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  chatInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent
  },
  smallText: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 3
  },
  mutedText: {
    color: colors.muted,
    fontSize: 13,
    paddingVertical: 8
  },
  errorText: {
    color: colors.error,
    fontSize: 13
  }
});
