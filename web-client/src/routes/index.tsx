import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Circle,
  Crown,
  Download,
  Link2,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  PlaySquare,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Shuffle,
  Trash2,
  Unplug,
  Upload,
  UsersRound,
  KeyRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { SyncplayWebConnection, type ConnectionConfig } from '~/syncplay/connection';
import type { SyncplayFile } from '~/syncplay/protocol';
import { createInitialSyncplayState, syncplayReducer, type TransferSession } from '~/syncplay/state';
import { calculateSyncCorrection } from '~/syncplay/syncControl';
import { TransferWebRTC, type TransferFileSink, type TransferFileSource } from '~/syncplay/transferWebRTC';

export const Route = createFileRoute('/')({
  component: WebClient,
});

type ConnectForm = {
  host: string;
  port: string;
  tls: boolean;
  username: string;
  room: string;
  password: string;
  proxyUrl: string;
};

const STORAGE_KEY = 'syncplay-web-form';
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const defaultForm: ConnectForm = {
  host: 'localhost',
  port: '8999',
  tls: false,
  username: 'WebGuest',
  room: 'default',
  password: '',
  proxyUrl: '/syncplay-proxy',
};

function loadForm(): ConnectForm {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return { ...defaultForm, ...JSON.parse(saved) };
    }
  } catch {
    // ignore
  }
  return defaultForm;
}

function saveForm(form: ConnectForm): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  } catch {
    // ignore
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function generateRoomPassword(): string {
  const letters =
    String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
    String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const d1 = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const d2 = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${letters}-${d1}-${d2}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Create a sink that builds a file in memory and triggers download on completion. */
function createBlobDownloadSink(fileName: string, onPath: (path: string | null) => void): TransferFileSink {
  const chunks: BlobPart[] = [];
  let completedPath: string | null = null;

  return {
    write(chunk: Uint8Array): void {
      chunks.push(chunk as unknown as BlobPart);
    },
    finalize(): string | null {
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      completedPath = fileName;
      onPath(fileName);
      return fileName;
    },
  };
}

/** Create a source from a File object using slice + arrayBuffer. */
function createFileSource(file: File): TransferFileSource {
  return {
    async read(offset: number, length: number): Promise<Uint8Array> {
      const slice = file.slice(offset, offset + length);
      const buf = await slice.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

function WebClient() {
  const [state, dispatch] = useReducer(syncplayReducer, undefined, createInitialSyncplayState);
  const [form, setForm] = useState(loadForm);
  const [chatDraft, setChatDraft] = useState('');
  const [syncPaused, setSyncPaused] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const [newPlaylistUrl, setNewPlaylistUrl] = useState('');
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);
  const [controllerPassword, setControllerPassword] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [newManagedRoomName, setNewManagedRoomName] = useState('');
  const [unreadChat, setUnreadChat] = useState(false);

  // Transfer UI state
  const [showTransferPanel, setShowTransferPanel] = useState(false);
  const [transferFileInput, setTransferFileInput] = useState<File | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const lastPlaybackSendRef = useRef(0);
  const hasMediaRef = useRef(false);
  const autoplayBlockedRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastConnectionConfigRef = useRef<ConnectionConfig | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const chatFocusedRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  // Active WebRTC transfer instances, keyed by transferId
  const transferInstancesRef = useRef<Record<string, TransferWebRTC>>({});

  const usersInRoom = state.rooms[state.profile.room] ?? [];
  const currentUser = usersInRoom.find(user => user.username === state.profile.username);
  const isReady = currentUser?.isReady ?? false;
  const connected = state.connection.status === 'connected';
  const connecting = state.connection.status === 'connecting';
  const controllerCount = usersInRoom.filter(u => u.isController).length;

  // Active transfers for display
  const activeTransfers = Object.values(state.transfer.transfers);

  const connection = useMemo(() => {
    return new SyncplayWebConnection(
      (status, error) => dispatch({ type: 'connection-status', status, error }),
      message => dispatch({ type: 'server-message', message }),
      () => ({
        position: videoRef.current && hasMediaRef.current ? videoRef.current.currentTime : null,
        paused: videoRef.current && hasMediaRef.current ? videoRef.current.paused : null,
      }),
    );
  }, []);

  // Wire transfer signaling through the connection
  useEffect(() => {
    connection.onTransferSignalReceived(signal => {
      // Find the transferId from recent state — walk all active instances
      for (const [transferId, instance] of Object.entries(transferInstancesRef.current)) {
        try {
          instance.handleSignal(signal);
          return;
        } catch {
          // ignore — may not be this instance's signal
        }
      }
    });
  }, [connection]);

  useEffect(() => () => connection.disconnect(), [connection]);

  useEffect(() => {
    hasMediaRef.current = !!mediaUrl;
  }, [mediaUrl]);

  // Chat unread indicator
  useEffect(() => {
    if (!chatFocusedRef.current && state.messages.length > prevMessageCountRef.current) {
      setUnreadChat(true);
    }
    prevMessageCountRef.current = state.messages.length;
  }, [state.messages]);

  useEffect(() => {
    if (!mediaUrl) {
      return;
    }

    return () => {
      const video = videoRef.current;
      if (video?.src === mediaUrl) {
        video.removeAttribute('src');
        video.load();
      }
      if (mediaUrl) {
        URL.revokeObjectURL(mediaUrl);
      }
    };
  }, [mediaUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (!mediaUrl || syncPaused || state.playback.setBy === state.profile.username) {
      video.playbackRate = 1;
      return;
    }

    const correction = calculateSyncCorrection({
      hasMedia: true,
      syncPaused,
      localPosition: video.currentTime,
      remotePosition: state.playback.position,
      remotePaused: state.playback.paused,
      localPlaying: !video.paused,
      doSeek: state.playback.doSeek,
    });

    isApplyingRemoteRef.current = true;
    video.playbackRate = correction.rate;
    if (typeof correction.seekTo === 'number') {
      video.currentTime = correction.seekTo;
    }
    if (correction.shouldPause) {
      video.pause();
    }
    if (correction.shouldPlay) {
      if (autoplayBlockedRef.current) {
        return;
      }
      void video.play().catch(() => {
        autoplayBlockedRef.current = true;
        dispatch({
          type: 'local-system-message',
          text: 'The browser blocked autoplay. Press play once and Syncplay can take over after that.',
        });
      });
    }
    window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
    }, 250);
  }, [mediaUrl, state.playback, state.profile.username, syncPaused]);

  useEffect(() => {
    if (state.connection.status !== 'error' && state.connection.status !== 'disconnected') {
      return;
    }
    if (!lastConnectionConfigRef.current || manualDisconnectRef.current) {
      return;
    }
    if (reconnectTimerRef.current) {
      return;
    }

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      const config = lastConnectionConfigRef.current;
      if (config && !manualDisconnectRef.current) {
        connection.connect(config);
      }
    }, 2500);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [connection, state.connection.status]);

  // ── Transfer WebRTC lifecycle ──────────────────────────────────────────

  // Watch for transfer state changes to start WebRTC when approved or ticketed
  useEffect(() => {
    for (const session of Object.values(state.transfer.transfers)) {
      const { transferId, status, role, token, file, offset } = session;

      // Already have an instance for this transfer
      if (transferInstancesRef.current[transferId]) continue;

      // Sender: transfer was approved by receiver
      if (status === 'approved' && role === 'sender' && file) {
        startSenderWebRTC(transferId, file);
        continue;
      }

      // Receiver: got a ticket from the server
      if (status === 'approved' && role === 'receiver' && token) {
        startReceiverWebRTC(transferId, token, file, offset);
        continue;
      }
    }
  }, [state.transfer]);

  function startSenderWebRTC(transferId: string, file: SyncplayFile): void {
    const sourceFile = transferFileInput;
    if (!sourceFile) {
      dispatch({
        type: 'local-system-message',
        text: `Cannot start transfer: no file selected for upload.`,
      });
      return;
    }

    const onControl = (msg: string) => {
      dispatch({ type: 'local-system-message', text: `Transfer: ${msg}` });
    };

    const instance = new TransferWebRTC(
      RTC_CONFIG,
      signal => {
        if (signal.sdp) {
          connection.sendTransferSdp(
            transferId,
            signal.sdp,
            signal.sdp.type === 'offer' ? 'offer' : 'answer',
          );
        }
        if (signal.ice) {
          connection.sendTransferIce(transferId, signal.ice);
        }
      },
      createNullSink(),
      onControl,
      file.size,
    );

    transferInstancesRef.current[transferId] = instance;

    // DataChannel open is handled internally; we need to wait for it to open,
    // then start uploading. We'll poll for open state.
    const checkAndUpload = () => {
      if (instance.isOpen()) {
        dispatch({
          type: 'local-system-message',
          text: `DataChannel open — uploading ${file.name}...`,
        });
        dispatch({ type: 'transfer-set-status', transferId, status: 'downloading' });
        const source = createFileSource(sourceFile);
        instance
          .upload(transferId, source, 0)
          .then(totalBytes => {
            dispatch({ type: 'transfer-completed', transferId, size: totalBytes });
            dispatch({
              type: 'local-system-message',
              text: `Transfer complete: ${file.name} (${formatBytes(totalBytes)})`,
            });
          })
          .catch(err => {
            dispatch({
              type: 'transfer-error',
              transferId,
              errorCode: 'upload-failed',
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        setTimeout(checkAndUpload, 100);
      }
    };

    instance.connect({ transferId, token: '', role: 'sender', offset: 0 });
    checkAndUpload();
  }

  function startReceiverWebRTC(
    transferId: string,
    token: string,
    file: SyncplayFile | null | undefined,
    offset: number,
  ): void {
    const fileName = file?.name ?? `download-${transferId}`;

    const onPath = (path: string | null) => {
      if (path) {
        dispatch({ type: 'transfer-set-completed-path', transferId, path });
      }
    };

    const sink = createBlobDownloadSink(fileName, onPath);

    const onControl = (msg: string) => {
      if (msg === 'DataChannel opened') {
        dispatch({ type: 'transfer-set-status', transferId, status: 'downloading' });
      }
    };

    const instance = new TransferWebRTC(
      RTC_CONFIG,
      signal => {
        if (signal.sdp) {
          connection.sendTransferSdp(
            transferId,
            signal.sdp,
            signal.sdp.type === 'offer' ? 'offer' : 'answer',
          );
        }
        if (signal.ice) {
          connection.sendTransferIce(transferId, signal.ice);
        }
      },
      sink,
      onControl,
      file?.size ?? null,
    );

    transferInstancesRef.current[transferId] = instance;
    instance.connect({ transferId, token, role: 'receiver', offset });

    dispatch({
      type: 'local-system-message',
      text: `Waiting for WebRTC connection for ${fileName}...`,
    });
  }

  function cancelTransfer(transferId: string): void {
    const instance = transferInstancesRef.current[transferId];
    if (instance) {
      instance.pause();
      delete transferInstancesRef.current[transferId];
    }
    connection.sendTransferCancel(transferId);
    dispatch({ type: 'transfer-cancel', transferId });
  }

  const updateForm = (field: keyof ConnectForm, value: string | boolean) => {
    setForm(current => {
      const next = { ...current, [field]: value };
      saveForm(next);
      return next;
    });
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    const parsedPort = Number(form.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: 'Port must be an integer between 1 and 65535.',
      });
      return;
    }

    // Parse room:password syntax
    const roomParts = form.room.split(':');
    const roomName = roomParts[0]?.trim() || defaultForm.room;
    const roomPass = roomParts.length > 1 ? roomParts.slice(1).join(':') : '';

    const config: ConnectionConfig = {
      host: form.host.trim(),
      port: parsedPort,
      tls: form.tls,
      username: form.username.trim() || defaultForm.username,
      room: roomName,
      proxyUrl: form.proxyUrl,
      password: form.password || roomPass || undefined,
    };

    setRoomPassword(roomPass);
    dispatch({ type: 'profile-updated', username: config.username, room: config.room });
    manualDisconnectRef.current = false;
    lastConnectionConfigRef.current = config;
    connection.connect(config);
  };

  const disconnect = () => {
    manualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Clean up all transfer instances
    for (const instance of Object.values(transferInstancesRef.current)) {
      instance.pause();
    }
    transferInstancesRef.current = {};
    connection.disconnect();
    dispatch({ type: 'connection-status', status: 'disconnected' });
  };

  const handleSlashCommand = (text: string): boolean => {
    if (!text.startsWith('/')) {
      return false;
    }

    const parts = text.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(' ');

    if (command === 'help') {
      dispatch({
        type: 'local-system-message',
        text:
          'Commands: /help - Show this help\n' +
          '/me <action> - Send an action message\n' +
          '/nick <name> - Change your displayed name',
      });
      return true;
    }

    if (command === 'me') {
      if (!rest || !connected) {
        return true;
      }
      connection.sendChat(`* ${state.profile.username} ${rest}`);
      return true;
    }

    if (command === 'nick') {
      if (!rest) {
        dispatch({ type: 'local-system-message', text: 'Usage: /nick <new-name>' });
        return true;
      }
      dispatch({ type: 'profile-updated', username: rest.trim(), room: state.profile.room });
      dispatch({ type: 'local-system-message', text: `Your name is now "${rest.trim()}".` });
      const current = loadForm();
      saveForm({ ...current, username: rest.trim() });
      setForm(current => ({ ...current, username: rest.trim() }));
      // Reconnect with new name
      if (connected && lastConnectionConfigRef.current) {
        const config = { ...lastConnectionConfigRef.current, username: rest.trim() };
        lastConnectionConfigRef.current = config;
        connection.connect(config);
      }
      return true;
    }

    return false;
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text) {
      return;
    }

    if (handleSlashCommand(text)) {
      setChatDraft('');
      return;
    }

    if (!connected) {
      dispatch({ type: 'local-system-message', text: 'You are not connected.' });
      setChatDraft('');
      return;
    }

    connection.sendChat(text);
    setChatDraft('');
  };

  const sendPlayback = useCallback(
    (doSeek = false) => {
      const video = videoRef.current;
      if (!video || !connected || isApplyingRemoteRef.current) {
        return;
      }

      dispatch({
        type: 'local-playback-updated',
        position: video.currentTime,
        paused: video.paused,
      });
      connection.sendPlayback(video.currentTime, video.paused, doSeek);
    },
    [connected, connection],
  );

  const selectMedia = (file: File | null) => {
    if (!file) {
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    setMediaUrl(nextUrl);
    setSelectedFile({ name: file.name, size: file.size });
    dispatch({
      type: 'local-system-message',
      text: `Loaded ${file.name}. Metadata will be sent after the browser reads the duration.`,
    });
  };

  const publishMedia = () => {
    const video = videoRef.current;
    if (!video || !mediaUrl) {
      return;
    }

    const media: SyncplayFile = {
      name: selectedFile?.name ?? 'Browser media',
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      size: selectedFile?.size ?? 0,
    };

    dispatch({ type: 'media-updated', media });
  };

  useEffect(() => {
    if (connected && state.media) {
      connection.sendFile(state.media);
    }
  }, [connected, connection, state.media]);

  const toggleReady = () => {
    connection.sendReady(!isReady);
  };

  const changeRoom = () => {
    const room = form.room.trim();
    if (!connected) {
      dispatch({ type: 'local-system-message', text: 'Connect before changing rooms.' });
      return;
    }
    if (!room) {
      dispatch({ type: 'local-system-message', text: 'Room name cannot be blank.' });
      return;
    }
    connection.sendRoom(room);
  };

  // Managed room actions
  const createManagedRoom = () => {
    const room = newManagedRoomName.trim() || state.profile.room || 'default';
    const password = generateRoomPassword();
    setControllerPassword(password);
    dispatch({
      type: 'local-system-message',
      text: `Creating controlled room "${room}"...`,
    });
    connection.createControlledRoom(room, password);
  };

  const identifyAsController = () => {
    const pw = controllerPassword.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!pw) {
      dispatch({ type: 'local-system-message', text: 'Enter a controller password.' });
      return;
    }
    setControllerPassword(pw);
    connection.identifyAsController(pw);
  };

  // Playlist actions
  const playlistAddCurrent = () => {
    const file = selectedFile?.name ?? 'Current media';
    const newFiles = [...state.playlist.files, file];
    connection.sendPlaylist(newFiles);
  };

  const playlistAddUrl = () => {
    const url = newPlaylistUrl.trim();
    if (!url) return;
    const newFiles = [...state.playlist.files, url];
    connection.sendPlaylist(newFiles);
    setNewPlaylistUrl('');
  };

  const playlistShuffle = () => {
    const shuffled = [...state.playlist.files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    connection.sendPlaylist(shuffled);
  };

  const playlistClear = () => {
    connection.sendPlaylist([]);
  };

  const playlistPlay = (index: number) => {
    connection.sendPlaylistIndex(index);
  };

  // ── Transfer actions ──────────────────────────────────────────────────

  const requestTransfer = (username: string) => {
    connection.requestTransfer(username, state.media);

    // Create a transfer placeholder
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: 'transfer-set-status',
      transferId,
      status: 'incoming-request',
      role: 'sender',
    });
  };

  const selectTransferFile = (file: File | null) => {
    setTransferFileInput(file);
    if (file) {
      dispatch({
        type: 'local-system-message',
        text: `Selected ${file.name} (${formatBytes(file.size)}) for transfer.`,
      });
    }
  };

  const acceptTransfer = (transferId: string) => {
    connection.acceptTransfer(transferId);
    dispatch({ type: 'transfer-set-status', transferId, status: 'approved' });
  };

  const rejectTransfer = (transferId: string) => {
    connection.rejectTransfer(transferId);
    dispatch({ type: 'transfer-set-status', transferId, status: 'cancelled' });
  };

  const statusLabel: Record<string, string> = {
    'incoming-request': 'Requested',
    'approved': 'Approved',
    'downloading': 'Transferring',
    'paused-local': 'Paused',
    'paused-source-offline': 'Source offline',
    'paused-source-changed-media': 'Source changed',
    'paused-receiver-offline': 'Receiver offline',
    'complete': 'Complete',
    'failed': 'Failed',
    'cancelled': 'Cancelled',
  };

  return (
    <main className="client-shell">
      <section className="stage-panel">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Syncplay Web</p>
            <h1>Join a watch room from the browser.</h1>
          </div>
          <div className="brand-right">
            <StatusPill status={state.connection.status} version={state.server.version} />
          </div>
        </div>

        <div className="video-frame">
          {mediaUrl ? (
            <video
              ref={videoRef}
              controls
              playsInline
              src={mediaUrl}
              onLoadedMetadata={() => {
                publishMedia();
              }}
              onPlay={() => {
                autoplayBlockedRef.current = false;
                sendPlayback();
              }}
              onPause={() => sendPlayback()}
              onSeeked={() => {
                if (isApplyingRemoteRef.current) {
                  return;
                }
                sendPlayback(true);
              }}
              onTimeUpdate={() => {
                const now = Date.now();
                if (now - lastPlaybackSendRef.current > 4000) {
                  lastPlaybackSendRef.current = now;
                  sendPlayback();
                }
              }}
            />
          ) : (
            <label className="empty-video">
              <Upload size={34} />
              <span>Choose a video file</span>
              <input
                type="file"
                accept="video/*,.mkv,.avi,.mp4,.webm,.mov"
                onChange={event => {
                  selectMedia(event.target.files?.[0] ?? null);
                }}
              />
            </label>
          )}
        </div>

        <div className="media-actions">
          <label className="file-button">
            <Upload size={18} />
            <span>Media</span>
            <input
              type="file"
              accept="video/*,.mkv,.avi,.mp4,.webm,.mov"
              onChange={event => {
                selectMedia(event.target.files?.[0] ?? null);
              }}
            />
          </label>
          <button type="button" onClick={() => sendPlayback(true)} disabled={!connected || !mediaUrl}>
            <Radio size={18} />
            Sync now
          </button>
          <button
            type="button"
            onClick={() => setSyncPaused(value => !value)}
            className={syncPaused ? 'active' : ''}
          >
            {syncPaused ? <Pause size={18} /> : <Play size={18} />}
            {syncPaused ? 'Sync paused' : 'Sync active'}
          </button>
          <button type="button" onClick={toggleReady} disabled={!connected} className={isReady ? 'ready' : ''}>
            <Check size={18} />
            {isReady ? 'Ready' : 'Not ready'}
          </button>
          <button
            type="button"
            onClick={() => setShowPlaylistPanel(v => !v)}
            className={showPlaylistPanel ? 'active' : ''}
            disabled={!connected}
          >
            <PlaySquare size={18} />
            Playlist
          </button>
          <button
            type="button"
            onClick={() => setShowTransferPanel(v => !v)}
            className={showTransferPanel ? 'active' : ''}
            disabled={!connected}
          >
            <ArrowUpFromLine size={18} />
            {activeTransfers.length > 0 ? `Transfers (${activeTransfers.length})` : 'Transfers'}
          </button>
        </div>
      </section>

      <aside className="side-panel">
        <form className="connect-card" onSubmit={connect}>
          <div className="card-title">
            <PlugZap size={20} />
            <h2>Connection</h2>
          </div>
          <div className="field-grid">
            <label>
              Host
              <input value={form.host} onChange={event => updateForm('host', event.target.value)} />
            </label>
            <label>
              Port
              <input
                value={form.port}
                inputMode="numeric"
                onChange={event => updateForm('port', event.target.value)}
              />
            </label>
            <label>
              Name
              <input
                value={form.username}
                onChange={event => updateForm('username', event.target.value)}
              />
            </label>
            <label>
              Room
              <input
                value={form.room}
                onChange={event => updateForm('room', event.target.value)}
                placeholder="room:password"
              />
            </label>
          </div>
          <label>
            Password
            <input
              value={form.password}
              type="password"
              autoComplete="current-password"
              onChange={event => updateForm('password', event.target.value)}
            />
          </label>
          <label>
            Proxy path
            <input value={form.proxyUrl} onChange={event => updateForm('proxyUrl', event.target.value)} />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.tls}
              onChange={event => updateForm('tls', event.target.checked)}
            />
            Use TLS to the Syncplay server
          </label>
          <div className="button-row">
            <button type="submit" disabled={connecting}>
              {connecting ? <LoaderCircle className="spin" size={18} /> : <Link2 size={18} />}
              Connect
            </button>
            <button type="button" onClick={disconnect} disabled={!connected && !connecting}>
              <Unplug size={18} />
              Disconnect
            </button>
          </div>
          <button
            type="button"
            className="secondary-wide"
            onClick={changeRoom}
            disabled={!connected}
          >
            Change room
          </button>
          {state.connection.error ? <p className="error-line">{state.connection.error}</p> : null}
        </form>

        <section className="room-card">
          <div className="card-title">
            <UsersRound size={20} />
            <h2>{state.profile.room}</h2>
            {usersInRoom.length > 0 ? (
              <span className="user-count-badge">{usersInRoom.length}</span>
            ) : null}
          </div>
          {controllerCount > 0 ? (
            <p className="controller-info">
              <Crown size={14} /> {controllerCount} controller
              {controllerCount > 1 ? 's' : ''}
            </p>
          ) : null}
          <div className="user-list">
            {usersInRoom.length === 0 ? (
              <p className="muted">No room list yet.</p>
            ) : (
              usersInRoom.map(user => (
                <div className="user-row" key={user.username}>
                  {user.isController ? (
                    <Crown size={12} className="crown-icon" />
                  ) : (
                    <Circle size={10} className={user.isReady ? 'ready-dot' : 'idle-dot'} />
                  )}
                  <div>
                    <strong>
                      {user.username}
                      {user.isController ? <Crown size={11} className="crown-inline" /> : null}
                    </strong>
                    <span>{user.file?.name ?? 'No media announced'}</span>
                  </div>
                  {/* Request transfer from this user */}
                  {user.username !== state.profile.username && user.file && connected ? (
                    <button
                      type="button"
                      className="transfer-request-btn"
                      title={`Request file transfer from ${user.username}`}
                      onClick={() => requestTransfer(user.username)}
                    >
                      <Download size={14} />
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Transfer Panel */}
        {showTransferPanel && connected ? (
          <section className="transfer-card">
            <div className="card-title">
              <ArrowUpFromLine size={20} />
              <h2>File Transfers</h2>
            </div>

            {/* Select file to upload for outgoing transfers */}
            <div className="transfer-upload-section">
              <label className="file-button transfer-file-pick">
                <Upload size={14} />
                <span>{transferFileInput ? transferFileInput.name : 'Choose file to share...'}</span>
                <input
                  type="file"
                  onChange={event => {
                    selectTransferFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
            </div>

            {/* Active transfers */}
            <div className="transfer-list">
              {activeTransfers.length === 0 ? (
                <p className="muted">
                  No active transfers. Request a file from a user in the room list above, or
                  select a file to share and wait for a request.
                </p>
              ) : (
                activeTransfers.map(session => (
                  <div className="transfer-item" key={session.transferId}>
                    <div className="transfer-item-info">
                      <span className="transfer-name">
                        {session.file?.name ?? `Transfer ${session.transferId.slice(0, 8)}`}
                      </span>
                      <span className="transfer-meta">
                        {session.role === 'sender' ? '↑ Sending' : '↓ Receiving'}
                        {' • '}
                        {statusLabel[session.status] ?? session.status}
                        {session.size ? ` • ${formatBytes(session.transferred)} / ${formatBytes(session.size)}` : ''}
                      </span>
                      {session.status === 'downloading' && session.size ? (
                        <div className="transfer-progress-bar">
                          <div
                            className="transfer-progress-fill"
                            style={{
                              width: `${session.size > 0 ? Math.min(100, (session.transferred / session.size) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      {session.status === 'incoming-request' && session.role === 'receiver' ? (
                        <div className="transfer-actions">
                          <button
                            type="button"
                            className="transfer-accept"
                            onClick={() => acceptTransfer(session.transferId)}
                          >
                            <Check size={14} /> Accept
                          </button>
                          <button
                            type="button"
                            className="transfer-reject"
                            onClick={() => rejectTransfer(session.transferId)}
                          >
                            <X size={14} /> Reject
                          </button>
                        </div>
                      ) : null}
                      {session.status !== 'complete' &&
                      session.status !== 'cancelled' &&
                      session.status !== 'failed' ? (
                        <div className="transfer-actions">
                          <button
                            type="button"
                            className="transfer-reject"
                            onClick={() => cancelTransfer(session.transferId)}
                          >
                            <X size={14} /> Cancel
                          </button>
                        </div>
                      ) : null}
                      {session.status === 'complete' && session.completedPath ? (
                        <span className="transfer-complete-label">
                          ✓ Saved as {session.completedPath}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        ) : null}

        {/* Managed Room Controls */}
        {connected ? (
          <section className="managed-room-card">
            <div className="card-title">
              <KeyRound size={20} />
              <h2>Room Controls</h2>
            </div>
            <div className="managed-room-form">
              <label>
                New room name
                <input
                  value={newManagedRoomName}
                  placeholder="Room name"
                  onChange={e => setNewManagedRoomName(e.target.value)}
                />
              </label>
              <button type="button" onClick={createManagedRoom} className="secondary-wide">
                Create Controlled Room
              </button>
              <label>
                Controller password
                <input
                  value={controllerPassword}
                  placeholder="XX-NNN-NNN"
                  onChange={e => setControllerPassword(e.target.value)}
                />
              </label>
              <button type="button" onClick={identifyAsController} className="secondary-wide">
                Identify as Controller
              </button>
            </div>
          </section>
        ) : null}

        {/* Playlist Panel */}
        {showPlaylistPanel && connected ? (
          <section className="playlist-card">
            <div className="card-title">
              <PlaySquare size={20} />
              <h2>Playlist</h2>
              {state.playlist.updatedBy ? (
                <span className="playlist-updated-by">by {state.playlist.updatedBy}</span>
              ) : null}
            </div>
            <div className="playlist-list">
              {state.playlist.files.length === 0 ? (
                <p className="muted">Playlist is empty.</p>
              ) : (
                state.playlist.files.map((file, index) => (
                  <div
                    key={`${file}-${index}`}
                    className={`playlist-item ${index === state.playlist.index ? 'active' : ''}`}
                    onClick={() => playlistPlay(index)}
                  >
                    <span className="playlist-index">{index + 1}</span>
                    <span className="playlist-name">{file}</span>
                  </div>
                ))
              )}
            </div>
            <div className="playlist-actions">
              <button
                type="button"
                onClick={playlistAddCurrent}
                disabled={!selectedFile}
                title="Add current media"
              >
                <Plus size={14} /> Current
              </button>
              <div className="playlist-url-row">
                <input
                  value={newPlaylistUrl}
                  placeholder="Media URL or name..."
                  onChange={e => setNewPlaylistUrl(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      playlistAddUrl();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={playlistAddUrl}
                  disabled={!newPlaylistUrl.trim()}
                  title="Add URL"
                >
                  <Plus size={14} />
                </button>
              </div>
              <button
                type="button"
                onClick={playlistShuffle}
                title="Shuffle"
                disabled={state.playlist.files.length === 0}
              >
                <Shuffle size={14} />
              </button>
              <button
                type="button"
                onClick={playlistClear}
                title="Clear"
                disabled={state.playlist.files.length === 0}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </section>
        ) : null}

        <section className="chat-card">
          <div className="card-title">
            <MessageSquare size={20} />
            <h2>Chat</h2>
            {unreadChat ? <span className="unread-dot" /> : null}
          </div>
          <div
            className="chat-log"
            ref={el => {
              if (el) {
                el.scrollTop = el.scrollHeight;
              }
            }}
          >
            {state.messages.length === 0 ? (
              <p className="muted">Server messages and room chat will show here.</p>
            ) : (
              state.messages.map(message => (
                <p key={message.id} className={`message ${message.kind}`}>
                  <span className="msg-time">{formatTime(message.createdAt)}</span>
                  {message.username ? <strong>{message.username}</strong> : null}
                  <span>{message.text}</span>
                </p>
              ))
            )}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <input
              ref={chatInputRef}
              value={chatDraft}
              placeholder={connected ? 'Message the room' : 'Use /help for commands'}
              onFocus={() => {
                chatFocusedRef.current = true;
                setUnreadChat(false);
              }}
              onBlur={() => {
                chatFocusedRef.current = false;
              }}
              onChange={event => setChatDraft(event.target.value)}
            />
            <button type="submit" disabled={!chatDraft.trim()} aria-label="Send chat">
              <Send size={18} />
            </button>
          </form>
        </section>
      </aside>
    </main>
  );
}

/** Returns a no-op sink for sender instances (they don't download). */
function createNullSink(): TransferFileSink {
  return { write() {} };
}

function StatusPill({ status, version }: { status: string; version: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
      <div className={`status-pill ${status}`}>
        <span />
        {status}
      </div>
      {version ? <span className="version-label">v{version}</span> : null}
    </div>
  );
}
