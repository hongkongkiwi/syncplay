import { createFileRoute } from '@tanstack/react-router';
import {
  Check,
  Circle,
  Crown,
  Info,
  KeyRound,
  Link2,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  Pause,
  Play,
  PlaySquare,
  Plus,
  PlugZap,
  Radio,
  Send,
  Shuffle,
  Smile,
  Sun,
  Trash2,
  Unplug,
  Upload,
  UsersRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, Component } from 'react';
import { SyncplayP2PConnection } from '~/syncplay/connectionV2';
import type { SyncEvent } from 'syncplay-p2p-client';
import type { ConnectionConfig } from '~/syncplay/connectionV2';
import { calculateSyncCorrection } from '~/syncplay/syncControl';

export const Route = createFileRoute('/')({
  component: WebClient,
});

// ── Types ──────────────────────────────────────────────────────────────

type ConnectForm = {
  host: string;
  username: string;
  room: string;
  password: string;
  turnUrl: string;
  sfu: boolean;
};

type ChatMessage = {
  id: string;
  kind: 'system' | 'chat' | 'error';
  username?: string;
  text: string;
  createdAt: number;
};

type RoomUser = {
  username: string;
  isReady: boolean;
  isController: boolean;
  file?: { name: string };
  rtt: number;
  iceState: 'new' | 'checking' | 'connected' | 'disconnected' | 'failed' | 'closed';
};

type RemotePlaystate = {
  position: number;
  paused: boolean;
  setBy: string;
  speed: number;
  doSeek: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'syncplay-web-form';
const MAX_MESSAGES = 100;

const defaultForm: ConnectForm = {
  host: 'localhost',
  username: 'WebGuest',
  room: 'default',
  password: '',
  turnUrl: '',
  sfu: false,
};

// ── Helpers ────────────────────────────────────────────────────────────

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
    const { password, ...safe } = form;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // ignore
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function makeMessageId(): string {
  return crypto.randomUUID();
}

// ── Component ──────────────────────────────────────────────────────────

class ErrorFallback extends Component<{children: React.ReactNode}, {hasError: boolean}> {
  constructor(props: {children: React.ReactNode}) { super(props); this.state = {hasError: false}; }
  static getDerivedStateFromError() { return {hasError: true}; }
  render() {
    if (this.state.hasError) return <div className="error-boundary"><p>Something went wrong.</p><button onClick={() => this.setState({hasError: false})}>Retry</button></div>;
    return this.props.children;
  }
}

function WebClient() {
  // Connection
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
  >('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Remote playstate
  const [playstate, setPlaystate] = useState<RemotePlaystate>({
    position: 0,
    paused: true,
    setBy: '',
    speed: 1,
    doSeek: false,
  });

  // Room users
  const [roomUsers, setRoomUsers] = useState<RoomUser[]>([]);

  // Transfer progress
  const [transferProgress, setTransferProgress] = useState<Array<{transferId:string, filename:string, progress:number, sentBytes:number, totalSize:number}>>([]);

  // Playlist (derived from connection snapshot)
  const [playlist, setPlaylistState] = useState<{
    files: string[];
    index: number;
    updatedBy: string;
  }>({ files: [], index: 0, updatedBy: '' });

  // Dark mode
  const [darkMode, setDarkMode] = useState(() => {
    // Default dark; check localStorage override
    const saved = localStorage.getItem('syncplay-web-theme');
    return saved !== null ? saved !== 'light' : true;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.remove('light-mode');
    } else {
      document.documentElement.classList.add('light-mode');
    }
    localStorage.setItem('syncplay-web-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Form & UI
  const [form, setForm] = useState(loadForm);
  const [chatDraft, setChatDraft] = useState('');
  const [syncPaused, setSyncPaused] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const [selectedSubtitles, setSelectedSubtitles] = useState<Array<{ filename: string; size: number; language?: string }>>([]);
  const [newPlaylistUrl, setNewPlaylistUrl] = useState('');
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);
  const [unreadChat, setUnreadChat] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);

  // Refs
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

  // Current identity
  const currentUsername = form.username.trim() || defaultForm.username;
  const currentRoom = (() => {
    const parts = form.room.split(':');
    return parts[0]?.trim() || defaultForm.room;
  })();

  const connected = connectionStatus === 'connected';
  const connecting = connectionStatus === 'connecting';

  // ── Connection ───────────────────────────────────────────────────────

  const handleSyncEventRef = useRef(handleSyncEvent);

  const connection = useMemo(() => {
    return new SyncplayP2PConnection(
      (status, error) => {
        setConnectionStatus(status);
        if (error !== undefined && error !== null) {
          setConnectionError(error);
        } else {
          setConnectionError(null);
        }
      },
      (event: SyncEvent) => {
        handleSyncEventRef.current(event);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  handleSyncEventRef.current = handleSyncEvent;

  // Handle incoming SyncEvent — update local state
  function handleSyncEvent(event: SyncEvent) {
    switch (event.type) {
      case 'chat': {
        const data = event.data as { from?: string; message?: string; timestamp?: number } | undefined;
        const chatMsg: ChatMessage = {
          id: makeMessageId(),
          kind: 'chat',
          username: data?.from ?? 'unknown',
          text: data?.message ?? '',
          createdAt: data?.timestamp ?? Date.now(),
        };
        setMessages(prev => {
          const next = [...prev, chatMsg];
          return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
        });
        break;
      }

      case 'playstate': {
        const data = event.data as {
          position?: number;
          paused?: boolean;
          doSeek?: boolean;
          setBy?: string;
          speed?: number;
        } | undefined;
        setPlaystate({
          position: data?.position ?? 0,
          paused: data?.paused ?? true,
          setBy: data?.setBy ?? '',
          speed: data?.speed ?? 1,
          doSeek: data?.doSeek ?? false,
        });
        break;
      }

      case 'user-join':
      case 'user-leave': {
        // Rebuild room users from snapshot
        try {
          const snap = connection.manager.getSnapshot();
          const users: RoomUser[] = snap.peers.map(p => ({
            username: p.username,
            isReady: p.isReady,
            isController: p.isController,
            file: p.file ? { name: p.file.name } : undefined,
            rtt: p.rtt,
            iceState: p.iceState,
          }));
          setRoomUsers(users);

          // Update playlist
          setPlaylistState({
            files: snap.playlist.map(e => e.name),
            index: snap.playlistIndex,
            updatedBy: '', // snapshot doesn't track who updated the playlist
          });
        } catch {
          // manager may not be ready
        }
        break;
      }

      case 'host-change': {
        // Host tracking updated by the StateManager internally;
        // we can also refresh the room user list to reflect new host
        try {
          const snap = connection.manager.getSnapshot();
          const users: RoomUser[] = snap.peers.map(p => ({
            username: p.username,
            isReady: p.isReady,
            isController: p.isController,
            file: p.file ? { name: p.file.name } : undefined,
            rtt: p.rtt,
            iceState: p.iceState,
          }));
          setRoomUsers(users);
        } catch {
          // ignore
        }
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
        const data = event.data as { message?: string } | undefined;
        const errMsg: ChatMessage = {
          id: makeMessageId(),
          kind: 'error',
          username: undefined,
          text: data?.message ?? 'Unknown error',
          createdAt: Date.now(),
        };
        setMessages(prev => [...prev, errMsg].slice(-MAX_MESSAGES));
        break;
      }
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => connection.disconnect();
  }, [connection]);

  // Track hasMedia
  useEffect(() => {
    hasMediaRef.current = !!mediaUrl;
  }, [mediaUrl]);

  // Chat unread indicator
  useEffect(() => {
    if (!chatFocusedRef.current && messages.length > prevMessageCountRef.current) {
      setUnreadChat(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // Media cleanup
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

  // ── Sync correction ──────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (!mediaUrl || syncPaused || playstate.setBy === currentUsername) {
      video.playbackRate = 1;
      return;
    }

    const correction = calculateSyncCorrection({
      hasMedia: true,
      syncPaused,
      localPosition: video.currentTime,
      remotePosition: playstate.position,
      remotePaused: playstate.paused,
      localPlaying: !video.paused,
      doSeek: playstate.doSeek,
    });

    isApplyingRemoteRef.current = true;
    video.playbackRate = correction.rate;
    // Apply host speed when not in correction mode
    if (correction.rate === 1 && playstate.speed !== 1) {
      video.playbackRate = playstate.speed;
    }
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
        addSystemMessage(
          'The browser blocked autoplay. Press play once and Syncplay can take over after that.',
        );
      });
    }
    window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
    }, 250);
  }, [mediaUrl, playstate, currentUsername, syncPaused]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  useEffect(() => {
    const applySpeed = (speed: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = speed;
      setPlaybackSpeed(speed);
      connection.requestSetSpeed(speed);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      // Don't capture when help is open (Escape handles it)
      if (showHelp && e.key !== 'Escape') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          connection.toggleReady();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          setSyncPaused(v => !v);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.currentTime += 10;
          }
          break;
        case 'a':
        case 'A':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.currentTime -= 10;
          }
          break;
        case '<':
        case ',':
          e.preventDefault();
          applySpeed(0.5);
          break;
        case '>':
        case '.':
          e.preventDefault();
          applySpeed(2);
          break;
        case '/':
          e.preventDefault();
          applySpeed(1);
          break;
        case '?':
          e.preventDefault();
          setShowHelp(v => !v);
          break;
        case 'Escape':
          if (showHelp) {
            e.preventDefault();
            setShowHelp(false);
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connection, connected, showHelp]);

  // ── Auto-reconnect ───────────────────────────────────────────────────

  useEffect(() => {
    if (connectionStatus !== 'error' && connectionStatus !== 'disconnected') {
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
  }, [connection, connectionStatus]);

  // ── Helpers ──────────────────────────────────────────────────────────

  function addSystemMessage(text: string) {
    const msg: ChatMessage = {
      id: makeMessageId(),
      kind: 'system',
      text,
      createdAt: Date.now(),
    };
    setMessages(prev => [...prev, msg].slice(-MAX_MESSAGES));
  }

  // ── Actions ──────────────────────────────────────────────────────────

  const updateForm = (field: keyof ConnectForm, value: string | boolean) => {
    setForm(current => {
      const next = { ...current, [field]: value };
      saveForm(next);
      return next;
    });
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();

    // Parse room:password syntax
    const roomParts = form.room.split(':');
    const roomName = roomParts[0]?.trim() || defaultForm.room;
    const roomPass = roomParts.length > 1 ? roomParts.slice(1).join(':') : '';

    const config: ConnectionConfig = {
      host: form.host.trim(),
      username: form.username.trim() || defaultForm.username,
      room: roomName,
      password: form.password || roomPass || undefined,
      turnUrl: form.turnUrl.trim() || undefined,
      sfu: form.sfu,
    };

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
    connection.disconnect();
    setConnectionStatus('disconnected');
    setConnectionError(null);
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text) {
      return;
    }

    if (text.startsWith('/')) {
      const result = connection.sendSlashCommand(text);
      setChatDraft('');
      if (typeof result === 'string') {
        addSystemMessage(result);
      }
      return;
    }

    if (!connected) {
      addSystemMessage('You are not connected.');
      setChatDraft('');
      return;
    }

    // Add message locally BEFORE sending (so sender sees their own message)
    addChatMessage(currentUsername, text);
    connection.sendChat(text);
    setChatDraft('');
  };

  function addChatMessage(from: string, text: string) {
    const msg: ChatMessage = {
      id: makeMessageId(),
      kind: 'chat',
      username: from,
      text,
      createdAt: Date.now(),
    };
    setMessages(prev => {
      const next = [...prev, msg];
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
  }

  const sendPlayback = useCallback(
    (doSeek = false) => {
      const video = videoRef.current;
      if (!video || !connected || isApplyingRemoteRef.current) {
        return;
      }

      connection.sendPlaystate(video.currentTime, video.paused, doSeek);
    },
    [connected, connection],
  );

  const selectMedia = (files: File[] | null) => {
    if (!files || files.length === 0) {
      return;
    }

    // Video file extensions to filter
    const VIDEO_EXTENSIONS = new Set([
      '.mkv', '.avi', '.mp4', '.webm', '.mov', '.ogv', '.flv',
      '.m4v', '.mpg', '.mpeg', '.wmv', '.3gp', '.ts',
    ]);

    // Find the first video file
    const videoFile = files.find(f => {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase();
      return VIDEO_EXTENSIONS.has(ext) || f.type.startsWith('video/');
    });

    if (!videoFile) {
      addSystemMessage('No video file found in selection.');
      return;
    }

    const nextUrl = URL.createObjectURL(videoFile);
    setMediaUrl(nextUrl);
    setSelectedFile({ name: videoFile.name, size: videoFile.size });

    // Detect subtitle files among the selected files
    const tracks = connection.manager.findSubtitles(files, videoFile.name);
    setSelectedSubtitles(tracks);

    if (tracks.length > 0) {
      const trackDesc = tracks
        .map(t => t.language ? `${t.filename} [${t.language}]` : t.filename)
        .join(', ');
      addSystemMessage(
        `Loaded ${videoFile.name}. Found ${tracks.length} subtitle file${tracks.length > 1 ? 's' : ''}: ${trackDesc}. Metadata will be sent after the browser reads the duration.`,
      );
    } else {
      addSystemMessage(
        `Loaded ${videoFile.name}. No subtitles found. Metadata will be sent after the browser reads the duration.`,
      );
    }
  };

  const publishMedia = () => {
    const video = videoRef.current;
    if (!video || !mediaUrl) {
      return;
    }

    // Store detected subtitle tracks so state manager can relay them
    connection.manager.setSubtitleTracks(selectedSubtitles);

    connection.sendFileInfo({
      name: selectedFile?.name ?? 'Browser media',
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      size: selectedFile?.size ?? 0,
    });
  };

  const toggleReady = () => {
    if (!connected) return;
    // Determine current ready state from room users
    const me = roomUsers.find(u => u.username === currentUsername);
    const currentlyReady = me?.isReady ?? false;
    connection.sendReady(!currentlyReady);
  };

  const toggleVoiceMute = () => {
    if (!connected) return;
    const newMuted = connection.toggleMute();
    setVoiceMuted(newMuted);
  };

  // Playlist actions
  const playlistAddCurrent = () => {
    if (!connected) return;
    const file = selectedFile?.name ?? 'Current media';
    connection.addToPlaylist([file]);
  };

  const playlistAddUrl = () => {
    const url = newPlaylistUrl.trim();
    if (!url || !connected) return;
    connection.addToPlaylist([url]);
    setNewPlaylistUrl('');
  };

  const playlistShuffle = () => {
    if (!connected) return;
    const shuffled = [...playlist.files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    connection.clearPlaylist();
    connection.addToPlaylist(shuffled);
  };

  const playlistClear = () => {
    if (!connected) return;
    connection.clearPlaylist();
  };

  const playlistPlay = (index: number) => {
    if (!connected) return;
    connection.setPlaylistIndex(index);
  };

  // Derived
  const currentUser = roomUsers.find(u => u.username === currentUsername);
  const isReady = currentUser?.isReady ?? false;

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <ErrorFallback>
    <main className="client-shell">
      <section className="stage-panel">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Syncplay Web</p>
            <h1>Join a watch room from the browser.</h1>
          </div>
          <div className="brand-right">
            <div className="brand-actions">
              <button
                type="button"
                className="theme-toggle"
                onClick={() => setDarkMode(v => !v)}
                title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? <Moon size={16} /> : <Sun size={16} />}
              </button>
              <StatusPill status={connectionStatus} />
            </div>
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
                multiple
                accept="video/*,.mkv,.avi,.mp4,.webm,.mov,.srt,.ass,.ssa,.vtt,.sub,.idx,.txt"
                onChange={event => {
                  selectMedia(event.target.files ? Array.from(event.target.files) : null);
                }}
              />
            </label>
          )}
        </div>

        {transferProgress.length > 0 ? (
          <div className="transfer-progress-section">
            {transferProgress.map(t => (
              <div key={t.transferId} className="transfer-item">
                <span className="transfer-name">{t.filename}</span>
                <div className="transfer-bar-track">
                  <div
                    className="transfer-bar-fill"
                    style={{ width: `${Math.round(t.progress * 100)}%` }}
                  />
                </div>
                <span className="transfer-pct">{Math.round(t.progress * 100)}%</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="media-actions">
          <label className="file-button">
            <Upload size={18} />
            <span>Media</span>
            <input
              type="file"
              multiple
              accept="video/*,.mkv,.avi,.mp4,.webm,.mov,.srt,.ass,.ssa,.vtt,.sub,.idx,.txt"
              onChange={event => {
                selectMedia(event.target.files ? Array.from(event.target.files) : null);
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
            {syncPaused ? 'Syncing paused' : 'Syncing'}
          </button>
          <span className="speed-display" title="Current playback speed">
            {playbackSpeed}x
          </span>
          <button type="button" onClick={toggleReady} disabled={!connected} className={isReady ? 'ready' : ''}>
            <Check size={18} />
            {isReady ? 'Ready' : 'Not ready'}
          </button>
          <button type="button" onClick={toggleVoiceMute} disabled={!connected} className={voiceMuted ? 'active' : ''}>
            {voiceMuted ? <MicOff size={18} /> : <Mic size={18} />}
            {voiceMuted ? 'Muted' : 'Voice'}
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
              Server
              <input value={form.host} onChange={event => updateForm('host', event.target.value)} title="WebSocket signaling server address (e.g. myserver.com or 192.168.1.5)" />
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
                placeholder="default"
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
            TURN Server (optional)
            <input
              value={form.turnUrl}
              placeholder="turn:user:pass@host:3478"
              onChange={event => updateForm('turnUrl', event.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.sfu}
              onChange={event => updateForm('sfu', event.target.checked)}
            />
            <span title="Server Forwarding Unit — routes all traffic through the server. Use for large rooms (5+ peers).">SFU Mode (large rooms)</span>
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
          {connectionError ? <p className="error-line">{connectionError}</p> : null}
        </form>

        <section className="room-card">
          <div className="card-title">
            <UsersRound size={20} />
            <h2>{currentRoom}</h2>
            {roomUsers.length > 0 ? (
              <span className="user-count-badge">{roomUsers.length}</span>
            ) : null}
          </div>
          {roomUsers.filter(u => u.isController).length > 0 ? (
            <p className="controller-info">
              <Crown size={14} />{' '}
              {roomUsers.filter(u => u.isController).length} controller
              {roomUsers.filter(u => u.isController).length > 1 ? 's' : ''}
            </p>
          ) : null}
          <div className="user-list">
            {roomUsers.length === 0 ? (
              <p className="muted">No room list yet.</p>
            ) : (
              roomUsers.map(user => {
                const iceColor =
                  user.iceState === 'connected' ? '#4ade80' :
                  user.iceState === 'checking' ? '#facc15' :
                  user.iceState === 'failed' || user.iceState === 'disconnected' ? '#ef4444' :
                  '#9ca3af';
                return (
                <div className="user-row" key={user.username}>
                  {user.isController ? (
                    <Crown size={12} className="crown-icon" />
                  ) : (
                    <Circle size={10} className={user.isReady ? 'ready-dot' : 'idle-dot'} />
                  )}
                  {user.isController ? null : (
                    <span
                      className="ice-dot"
                      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: iceColor, flexShrink: 0 }}
                      title={`ICE: ${user.iceState}`}
                    />
                  )}
                  <div>
                    <strong>
                      {user.username}
                      {user.rtt > 0 ? <span className="rtt-badge"> ({user.rtt}ms)</span> : null}
                      {user.isController ? <Crown size={11} className="crown-inline" /> : null}
                    </strong>
                    <span>{user.file?.name ?? 'No media announced'}</span>
                  </div>
                  {connection.isHost && user.username !== currentUsername ? (
                    <button
                      type="button"
                      className="inline-action-btn"
                      title={user.isController ? 'Remove controller' : 'Make controller'}
                      onClick={() => user.isController ? connection.removeController(user.username) : connection.addController(user.username)}
                    >
                      {user.isController ? <X size={14} /> : <Crown size={14} />}
                    </button>
                  ) : null}
                </div>
                );
              })
            )}
          </div>
        </section>

        {/* Playlist Panel */}
        {showPlaylistPanel && connected ? (
          <section className="playlist-card">
            <div className="card-title">
              <PlaySquare size={20} />
              <h2>Playlist</h2>
              {playlist.updatedBy ? (
                <span className="playlist-updated-by">by {playlist.updatedBy}</span>
              ) : null}
            </div>
            <div className="playlist-list">
              {playlist.files.length === 0 ? (
                <p className="muted">Playlist is empty.</p>
              ) : (
                playlist.files.map((file, index) => (
                  <div
                    key={`${file}-${index}`}
                    className={`playlist-item ${index === playlist.index ? 'active' : ''}`}
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
                disabled={playlist.files.length === 0}
              >
                <Shuffle size={14} />
              </button>
              <button
                type="button"
                onClick={playlistClear}
                title="Clear"
                disabled={playlist.files.length === 0}
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
            {messages.length === 0 ? (
              <p className="muted">Server messages and room chat will show here.</p>
            ) : (
              messages.map(message => (
                <p key={message.id} className={`message ${message.kind}`}>
                  <span className="msg-time">{formatTime(message.createdAt)}</span>
                  {message.username ? <strong>{message.username}</strong> : null}
                  <span>{message.text}</span>
                </p>
              ))
            )}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <div className="emoji-bar">
              {['😊','😂','❤️','👍','🔥','👏','🎉','💀','🚀','🍿'].map(emoji => (
                <button key={emoji} type="button" className="emoji-btn"
                  onClick={() => setChatDraft(d => d + emoji)}
                  title={`Insert ${emoji}`}>{emoji}</button>
              ))}
            </div>
            <div className="chat-input-row">
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
            </div>
          </form>
        </section>
      </aside>

      {/* Help overlay */}
      {showHelp ? (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-panel" onClick={e => e.stopPropagation()}>
            <div className="card-title">
              <h2>Keyboard Shortcuts</h2>
              <button type="button" onClick={() => setShowHelp(false)} className="help-close">
                &times;
              </button>
            </div>
            <div className="help-grid">
              <div className="help-section">
                <h3>Playback</h3>
                <ul>
                  <li><kbd>Space</kbd> Toggle ready</li>
                  <li><kbd>p</kbd> Toggle pause/play</li>
                  <li><kbd>s</kbd> Seek +10s</li>
                  <li><kbd>a</kbd> Seek -10s</li>
                </ul>
              </div>
              <div className="help-section">
                <h3>Speed</h3>
                <ul>
                  <li><kbd>&lt;</kbd> / <kbd>,</kbd> Set 0.5x</li>
                  <li><kbd>&gt;</kbd> / <kbd>.</kbd> Set 2x</li>
                  <li><kbd>/</kbd> Reset to 1x</li>
                </ul>
              </div>
              <div className="help-section">
                <h3>Chat</h3>
                <ul>
                  <li><kbd>/me &lt;action&gt;</kbd> Send action</li>
                  <li><kbd>/shrug</kbd> ¯\_(ツ)_/¯</li>
                  <li><kbd>/tableflip</kbd> (╯°□°）╯︵ ┻━┻</li>
                  <li><kbd>/lenny</kbd> ( ͡° ͜ʖ ͡°)</li>
                </ul>
              </div>
              <div className="help-section">
                <h3>Other</h3>
                <ul>
                  <li><kbd>?</kbd> Toggle this help</li>
                  <li><kbd>Escape</kbd> Close help</li>
                  <li>Use buttons for speed, playlist, ready, controllers</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
    </ErrorFallback>
  );
}

// ── StatusPill ─────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  return (
    <div className={`status-pill ${status}`}>
      <span />
      {status}
    </div>
  );
}
