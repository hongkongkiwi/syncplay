// Message types matching Rust syncplay-p2p messages.rs — v2.0.0 P2P protocol
// Wire format: [4B type u32 BE][4B len u32 BE][N bytes msgpack]

export enum MessageType {
  Hello = 0x01,
  Playstate = 0x02,
  PlaystateRequest = 0x03,
  Chat = 0x04,
  Readiness = 0x05,
  PlaylistChange = 0x06,
  PlaylistRequest = 0x07,
  FileInfo = 0x08,
  FileTransfer = 0x09,
  FileRequest = 0x0a,
  FileResponse = 0x0b,
  LatencyPing = 0x0c,
  LatencyPong = 0x0d,
  HostElected = 0x0e,
  UserInfo = 0x0f,
  PeerDisconnect = 0x10,
  VoiceMute = 0x11,
  SubtitleInfo = 0x12,
  ControllerChange = 0x13,
}

// ── Payload types ──────────────────────────────────────────────

export interface HelloPayload {
  username: string;
  version: string;
  room: string;
  features: string[];
}

export interface PlaystatePayload {
  position: number;
  paused: boolean;
  doSeek: boolean;
  setBy: string;
  seq: number;
  timestamp: number;
  speed: number;
}

export enum PlaystateAction {
  Seek = "seek",
  Pause = "pause",
  Play = "play",
  SetSpeed = "set_speed",
}

export interface PlaystateRequestPayload {
  action: PlaystateAction | { SetSpeed: number };
  position: number;
  requestId: string;
}

export interface ChatPayload {
  from: string;
  message: string;
  timestamp: number;
}

export interface ReadinessPayload {
  username: string;
  isReady: boolean;
  manuallyInitiated: boolean;
  setBy: string;
}

export interface FileEntry {
  name: string;
  duration: number;
}

export enum PlaylistAction {
  SetPlaylist = "set_playlist",
  SetIndex = "set_index",
}

export interface PlaylistChangePayload {
  files: FileEntry[];
  index: number;
  setBy: string;
}

export interface PlaylistRequestPayload {
  action: PlaylistAction;
  files: FileEntry[];
  index: number;
}

export interface FileMetadata {
  name: string;
  duration: number;
  size: number;
  checksum?: string;
}

export interface FileInfoPayload {
  username: string;
  file?: FileMetadata;
}

export interface FileTransferPayload {
  transferId: string;
  chunkIndex: number;
  offset: number;
  totalSize: number;
  chunkSize: number;
  data: Uint8Array;
}

export interface FileRequestPayload {
  transferId: string;
  filename: string;
  offset: number;
  fingerprint: string;
}

export interface FileResponsePayload {
  transferId: string;
  accepted: boolean;
  reason: string;
  fingerprint: string;
  chunkSize: number;
}

export interface LatencyPingPayload {
  sendTime: number;
}

export interface LatencyPongPayload {
  sendTime: number;
  receiveTime: number;
}

export interface HostElectedPayload {
  hostId: string;
  reason: string;
}

export interface UserInfoPayload {
  username: string;
  features: string[];
}

export interface PeerDisconnectPayload {
  reason: string;
}

export interface VoiceMutePayload {
  muted: boolean;
}

export interface SubtitleTrack {
  filename: string;
  size: number;
  language?: string;
}

export interface SubtitleInfoPayload {
  subtitles: SubtitleTrack[];
}

export enum ControllerAction {
  Add = "add",
  Remove = "remove",
}

export interface ControllerChangePayload {
  peer_id: string;
  action: ControllerAction;
}

// Type mapping for encode/decode
export const PAYLOAD_BY_TYPE: Record<MessageType, string> = {
  [MessageType.Hello]: "HelloPayload",
  [MessageType.Playstate]: "PlaystatePayload",
  [MessageType.PlaystateRequest]: "PlaystateRequestPayload",
  [MessageType.Chat]: "ChatPayload",
  [MessageType.Readiness]: "ReadinessPayload",
  [MessageType.PlaylistChange]: "PlaylistChangePayload",
  [MessageType.PlaylistRequest]: "PlaylistRequestPayload",
  [MessageType.FileInfo]: "FileInfoPayload",
  [MessageType.FileTransfer]: "FileTransferPayload",
  [MessageType.FileRequest]: "FileRequestPayload",
  [MessageType.FileResponse]: "FileResponsePayload",
  [MessageType.LatencyPing]: "LatencyPingPayload",
  [MessageType.LatencyPong]: "LatencyPongPayload",
  [MessageType.HostElected]: "HostElectedPayload",
  [MessageType.UserInfo]: "UserInfoPayload",
  [MessageType.PeerDisconnect]: "PeerDisconnectPayload",
  [MessageType.VoiceMute]: "VoiceMutePayload",
  [MessageType.SubtitleInfo]: "SubtitleInfoPayload",
  [MessageType.ControllerChange]: "ControllerChangePayload",
};

// ── Builders ───────────────────────────────────────────────────

export function helloPayload(
  username: string,
  version: string,
  room: string,
  features: string[],
): HelloPayload {
  return { username, version, room, features };
}

export function playstatePayload(
  position: number,
  paused: boolean,
  doSeek: boolean,
  setBy: string,
  seq: number,
  speed = 1.0,
): PlaystatePayload {
  return {
    position,
    paused,
    doSeek,
    setBy,
    seq,
    timestamp: Date.now(),
    speed,
  };
}

export function chatPayload(from: string, message: string): ChatPayload {
  return { from, message, timestamp: Date.now() };
}

export function readinessPayload(
  username: string,
  isReady: boolean,
  manuallyInitiated: boolean,
  setBy: string,
): ReadinessPayload {
  return { username, isReady, manuallyInitiated, setBy };
}

export function playstateRequestSeek(position: number): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Seek,
    position,
    requestId: crypto.randomUUID(),
  };
}

export function playstateRequestPause(): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Pause,
    position: 0,
    requestId: crypto.randomUUID(),
  };
}

export function playstateRequestPlay(): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Play,
    position: 0,
    requestId: crypto.randomUUID(),
  };
}

export function playstateRequestSetSpeed(
  speed: number,
): PlaystateRequestPayload {
  return {
    action: { SetSpeed: speed },
    position: 0,
    requestId: crypto.randomUUID(),
  };
}

export function peerDisconnectPayload(
  reason: string,
): PeerDisconnectPayload {
  return { reason };
}
