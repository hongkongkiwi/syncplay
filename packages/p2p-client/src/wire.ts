// Binary wire protocol matching Rust wire.rs — v2.0.0
// Frame: [4B type u32 BE][4B payload_len u32 BE][N bytes msgpack]

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { MessageType } from "./messages.ts";

const HEADER_SIZE = 8;
const MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB

/** Encode a typed payload into a wire frame. Returns Uint8Array. */
export function encode<T>(msgType: MessageType, payload: T): Uint8Array {
  const body = msgpackEncode(payload);
  if (body.byteLength > MAX_PAYLOAD) {
    throw new Error(
      `Payload too large: ${body.byteLength} > ${MAX_PAYLOAD}`,
    );
  }
  const frame = new Uint8Array(HEADER_SIZE + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, msgType, false); // big-endian
  view.setUint32(4, body.byteLength, false);
  frame.set(body, HEADER_SIZE);
  return frame;
}

/** Decode a wire frame header. Returns [MessageType, total_frame_length]. */
export function decodeHeader(buf: Uint8Array): [MessageType, number] {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`Incomplete header: have ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rawType = view.getUint32(0, false);
  const payloadLen = view.getUint32(4, false);
  if (payloadLen > MAX_PAYLOAD) {
    throw new Error(`Oversized payload: ${payloadLen} > ${MAX_PAYLOAD}`);
  }
  if (!(rawType in MessageType)) {
    throw new Error(`Unknown message type: 0x${rawType.toString(16)}`);
  }
  return [rawType as MessageType, HEADER_SIZE + payloadLen];
}

/** Decode payload from a complete frame. Returns typed payload. */
export function decode<T>(buf: Uint8Array): [MessageType, T] {
  const [msgType, frameLen] = decodeHeader(buf);
  const body = buf.slice(HEADER_SIZE, frameLen);
  return [msgType, msgpackDecode(body) as T];
}

/** Encode a chat message */
export function encodeChat(from: string, message: string): Uint8Array {
  return encode(MessageType.Chat, {
    from,
    message,
    timestamp: Date.now(),
  });
}

/** Encode a readiness message */
export function encodeReadiness(
  username: string,
  isReady: boolean,
): Uint8Array {
  return encode(MessageType.Readiness, {
    username,
    isReady,
    manuallyInitiated: true,
    setBy: username,
  });
}

/** Encode a PeerDisconnect message */
export function encodeDisconnect(reason: string): Uint8Array {
  return encode(MessageType.PeerDisconnect, { reason });
}
