import { createFileRoute } from '@tanstack/react-router';
import {
  Check,
  Circle,
  Link2,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  PlugZap,
  Radio,
  Send,
  Unplug,
  Upload,
  UsersRound
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { SyncplayWebConnection, type ConnectionConfig } from '~/syncplay/connection';
import type { SyncplayFile } from '~/syncplay/protocol';
import { createInitialSyncplayState, syncplayReducer } from '~/syncplay/state';
import { calculateSyncCorrection } from '~/syncplay/syncControl';

export const Route = createFileRoute('/')({
  component: WebClient
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

const initialForm: ConnectForm = {
  host: 'localhost',
  port: '8999',
  tls: false,
  username: 'WebGuest',
  room: 'default',
  password: '',
  proxyUrl: '/syncplay-proxy'
};

function WebClient() {
  const [state, dispatch] = useReducer(syncplayReducer, undefined, createInitialSyncplayState);
  const [form, setForm] = useState(initialForm);
  const [chatDraft, setChatDraft] = useState('');
  const [syncPaused, setSyncPaused] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const lastPlaybackSendRef = useRef(0);
  const hasMediaRef = useRef(false);

  const usersInRoom = state.rooms[state.profile.room] ?? [];
  const currentUser = usersInRoom.find(user => user.username === state.profile.username);
  const isReady = currentUser?.isReady ?? false;
  const connected = state.connection.status === 'connected';
  const connecting = state.connection.status === 'connecting';

  const connection = useMemo(() => {
    return new SyncplayWebConnection(
      (status, error) => dispatch({ type: 'connection-status', status, error }),
      message => dispatch({ type: 'server-message', message }),
      () => ({
        position: videoRef.current && hasMediaRef.current ? videoRef.current.currentTime : null,
        paused: videoRef.current && hasMediaRef.current ? videoRef.current.paused : null
      })
    );
  }, []);

  useEffect(() => () => connection.disconnect(), [connection]);

  useEffect(() => {
    hasMediaRef.current = !!mediaUrl;
  }, [mediaUrl]);

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
      URL.revokeObjectURL(mediaUrl);
    };
  }, [mediaUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !mediaUrl || syncPaused || state.playback.setBy === state.profile.username) {
      return;
    }

    const correction = calculateSyncCorrection({
      hasMedia: true,
      syncPaused,
      localPosition: video.currentTime,
      remotePosition: state.playback.position,
      remotePaused: state.playback.paused,
      localPlaying: !video.paused,
      doSeek: state.playback.doSeek
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
      void video.play().catch(() => {
        dispatch({
          type: 'local-system-message',
          text: 'The browser blocked autoplay. Press play once and Syncplay can take over after that.'
        });
      });
    }
    window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
    }, 250);
  }, [mediaUrl, state.playback, state.profile.username, syncPaused]);

  const updateForm = (field: keyof ConnectForm, value: string | boolean) => {
    setForm(current => ({ ...current, [field]: value }));
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    const parsedPort = Number(form.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      dispatch({
        type: 'connection-status',
        status: 'error',
        error: 'Port must be an integer between 1 and 65535.'
      });
      return;
    }

    const config: ConnectionConfig = {
      host: form.host.trim(),
      port: parsedPort,
      tls: form.tls,
      username: form.username.trim() || initialForm.username,
      room: form.room.trim() || initialForm.room,
      proxyUrl: form.proxyUrl,
      password: form.password || undefined
    };

    dispatch({ type: 'profile-updated', username: config.username, room: config.room });
    connection.connect(config);
  };

  const disconnect = () => {
    connection.disconnect();
    dispatch({ type: 'connection-status', status: 'disconnected' });
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!connected || !text) {
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
        paused: video.paused
      });
      connection.sendPlayback(video.currentTime, video.paused, doSeek);
    },
    [connected, connection]
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
      text: `Loaded ${file.name}. Metadata will be sent after the browser reads the duration.`
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
      size: selectedFile?.size ?? 0
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

  return (
    <main className="client-shell">
      <section className="stage-panel">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Syncplay Web</p>
            <h1>Join a watch room from the browser.</h1>
          </div>
          <StatusPill status={state.connection.status} />
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
              onPlay={() => sendPlayback()}
              onPause={() => sendPlayback()}
              onSeeked={() => sendPlayback(true)}
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
          <button type="button" onClick={() => setSyncPaused(value => !value)} className={syncPaused ? 'active' : ''}>
            {syncPaused ? <Pause size={18} /> : <Play size={18} />}
            {syncPaused ? 'Sync paused' : 'Sync active'}
          </button>
          <button type="button" onClick={toggleReady} disabled={!connected} className={isReady ? 'ready' : ''}>
            <Check size={18} />
            {isReady ? 'Ready' : 'Not ready'}
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
              <input value={form.port} inputMode="numeric" onChange={event => updateForm('port', event.target.value)} />
            </label>
            <label>
              Name
              <input value={form.username} onChange={event => updateForm('username', event.target.value)} />
            </label>
            <label>
              Room
              <input value={form.room} onChange={event => updateForm('room', event.target.value)} />
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
            <input type="checkbox" checked={form.tls} onChange={event => updateForm('tls', event.target.checked)} />
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
          <button type="button" className="secondary-wide" onClick={changeRoom} disabled={!connected}>
            Change room
          </button>
          {state.connection.error ? <p className="error-line">{state.connection.error}</p> : null}
        </form>

        <section className="room-card">
          <div className="card-title">
            <UsersRound size={20} />
            <h2>{state.profile.room}</h2>
          </div>
          <div className="user-list">
            {usersInRoom.length === 0 ? (
              <p className="muted">No room list yet.</p>
            ) : (
              usersInRoom.map(user => (
                <div className="user-row" key={user.username}>
                  <Circle size={10} className={user.isReady ? 'ready-dot' : 'idle-dot'} />
                  <div>
                    <strong>{user.username}</strong>
                    <span>{user.file?.name ?? 'No media announced'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="chat-card">
          <div className="card-title">
            <MessageSquare size={20} />
            <h2>Chat</h2>
          </div>
          <div className="chat-log">
            {state.messages.length === 0 ? (
              <p className="muted">Server messages and room chat will show here.</p>
            ) : (
              state.messages.map(message => (
                <p key={message.id} className={`message ${message.kind}`}>
                  {message.username ? <strong>{message.username}</strong> : null}
                  <span>{message.text}</span>
                </p>
              ))
            )}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <input
              value={chatDraft}
              placeholder="Message the room"
              onChange={event => setChatDraft(event.target.value)}
            />
            <button type="submit" disabled={!connected || !chatDraft.trim()} aria-label="Send chat">
              <Send size={18} />
            </button>
          </form>
        </section>
      </aside>
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <div className={`status-pill ${status}`}>
      <span />
      {status}
    </div>
  );
}
