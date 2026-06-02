import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';

const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const MAX_PORT = 65535;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MiB

export function syncplayProxyPlugin(): Plugin {
  return {
    name: 'syncplay-web-proxy',
    configureServer(server) {
      attachProxy(server.httpServer);
    },
    configurePreviewServer(server) {
      attachProxy(server.httpServer);
    }
  };
}

type UpgradeServer = {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): unknown;
};

function attachProxy(httpServer: UpgradeServer | null): void {
  if (!httpServer) {
    return;
  }

  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.SYNCPLAY_WEB_ALLOWED_HOSTS
  ) {
    console.warn(
      '[syncplay-web-proxy] SYNCPLAY_WEB_ALLOWED_HOSTS is not set. ' +
        'The proxy will only allow connections to localhost. ' +
        'Set SYNCPLAY_WEB_ALLOWED_HOSTS=* or a comma-separated host list ' +
        'when deploying near public Syncplay servers.'
    );
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const connectionsPerIp = new Map<string, number[]>();

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/syncplay-proxy') {
      return;
    }

    const origin = validateOrigin(request);
    if (!origin.ok) {
      socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${origin.error}`);
      socket.destroy();
      return;
    }

    const target = parseTarget(url);
    if (!target.ok) {
      socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${target.error}`);
      socket.destroy();
      return;
    }

    // Rate limit: max connections per IP (timestamp-based, decaying window)
    const clientIp = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let timestamps = connectionsPerIp.get(clientIp) ?? [];
    // Prune entries older than 60 seconds
    timestamps = timestamps.filter(ts => now - ts < 60_000);
    if (timestamps.length >= MAX_CONNECTIONS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\nToo many connections.');
      socket.destroy();
      return;
    }
    timestamps.push(now);
    connectionsPerIp.set(clientIp, timestamps);

    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('close', () => {
        const timestamps = connectionsPerIp.get(clientIp);
        if (!timestamps) return;
        const pruned = timestamps.filter(ts => Date.now() - ts < 60_000);
        if (pruned.length === 0) {
          connectionsPerIp.delete(clientIp);
        } else {
          connectionsPerIp.set(clientIp, pruned);
        }
      });
      bridgeSyncplay(ws, target.value, request);
    });
  });

  // Cleanup stale entries periodically
  setInterval(() => {
    if (connectionsPerIp.size > 1000) {
      connectionsPerIp.clear();
    }
  }, 60_000).unref();
}

type ProxyTarget = {
  host: string;
  port: number;
  tls: boolean;
};

type ParseResult = { ok: true; value: ProxyTarget } | { ok: false; error: string };

type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validates the Origin header of an incoming WebSocket upgrade request.
 *
 * ## Trust Model
 *
 * This proxy sits between the browser and upstream Syncplay servers. It acts
 * as a same-origin gateway (typically deployed on the same domain as the
 * web frontend) and enforces two layers of protection:
 *
 * 1. **Origin validation (this function):** Prevents other websites from
 *    connecting their visitors' browsers to this proxy via cross-origin
 *    WebSocket requests. Browsers always send the `Origin` header on
 *    cross-origin WebSocket upgrades, so this is a browser-enforced boundary.
 *
 * 2. **Host allowlist (`parseTarget` / `isAllowedHost`):** Prevents the proxy
 *    from being abused to relay connections to arbitrary internal hosts (SSRF).
 *    Even if origin validation is bypassed (e.g., `curl` without an Origin
 *    header), the target host must still be in `SYNCPLAY_WEB_ALLOWED_HOSTS`.
 *
 * **Why no-Origin requests are allowed in dev / without allowlist:**
 * Non-browser clients (`curl`, scripts, native apps) do not send `Origin`.
 * Blocking them unconditionally would break legitimate use. The host allowlist
 * (`SYNCPLAY_WEB_ALLOWED_HOSTS`) provides the SSRF guardrail. In production
 * with `SYNCPLAY_WEB_ALLOWED_ORIGINS` set, the Origin header is required
 * (browsers always send it, so this only blocks non-browser callers that
 * could be cross-origin SSRF).
 */
function validateOrigin(request: IncomingMessage): ValidationResult {
  const origin = request.headers.origin;

  const hasAllowlist = !!(process.env.SYNCPLAY_WEB_ALLOWED_ORIGINS ?? '').trim();
  if (!origin) {
    if (
      process.env.NODE_ENV === 'production' &&
      hasAllowlist
    ) {
      return { ok: false, error: 'WebSocket origin is required.' };
    }
    // In production without an origin allowlist, browsers still enforce
    // same-origin by default since they always send Origin on cross-origin
    // WebSocket upgrades. Non-browser clients without Origin are allowed;
    // the host allowlist prevents SSRF abuse.
    if (
      process.env.NODE_ENV === 'production' &&
      !hasAllowlist
    ) {
      console.warn(
        '[syncplay-web-proxy] SYNCPLAY_WEB_ALLOWED_ORIGINS is not set. ' +
          'The proxy allows WebSocket upgrades without an Origin header ' +
          '(non-browser clients). In production deployments, set ' +
          'SYNCPLAY_WEB_ALLOWED_ORIGINS to restrict cross-origin access.'
      );
    }
    return { ok: true };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return { ok: false, error: 'Invalid WebSocket origin.' };
  }

  if (!hasAllowlist) {
    // No allowlist configured: check against host header (same-origin)
    const host = request.headers.host?.toLowerCase();
    if (host && normalizedOrigin === `http://${host}`) {
      return { ok: true };
    }
    if (host && normalizedOrigin === `https://${host}`) {
      return { ok: true };
    }
    return { ok: false, error: 'WebSocket origin not allowed.' };
  }

  const allowedOrigins = (process.env.SYNCPLAY_WEB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter((value): value is string => !!value);

  if (allowedOrigins.includes('*') || allowedOrigins.includes(normalizedOrigin)) {
    return { ok: true };
  }

  return { ok: false, error: 'WebSocket origin not allowed.' };
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '*') {
    return '*';
  }
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return null;
  }
}

function parseTarget(url: URL): ParseResult {
  const host = (url.searchParams.get('host') ?? '').trim();
  const port = Number(url.searchParams.get('port') ?? '8999');
  const useTls = url.searchParams.get('tls') === '1';

  if (!host) {
    return { ok: false, error: 'Missing Syncplay host.' };
  }

  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return { ok: false, error: 'Invalid Syncplay port.' };
  }

  if (!isAllowedHost(host)) {
    return { ok: false, error: 'Host not allowed.' };
  }

  return { ok: true, value: { host, port, tls: useTls } };
}

function isAllowedHost(host: string): boolean {
  const allowedHosts = (process.env.SYNCPLAY_WEB_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS.join(','))
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (allowedHosts.includes('*')) {
    return true;
  }

  return allowedHosts.includes(host.toLowerCase());
}

function bridgeSyncplay(ws: WebSocket, target: ProxyTarget, request: IncomingMessage): void {
  let connected = false;
  const syncplaySocket = target.tls
    ? tls.connect({ host: target.host, port: target.port, servername: target.host })
    : net.connect({ host: target.host, port: target.port });
  const connectTimer = setTimeout(() => {
    if (connected) {
      return;
    }
    const message = 'Timed out connecting to upstream server.';
    if (ws.readyState === ws.OPEN) {
      const errorPayload = JSON.stringify({ Error: { message } }) + '\r\n';
      ws.send(errorPayload, () => ws.close(1011, 'Upstream connect timeout'));
    }
    syncplaySocket.destroy(new Error(message));
  }, 10_000);

  const clearConnectTimer = () => {
    clearTimeout(connectTimer);
  };

  const closeBoth = (code = 1000, reason = 'closed') => {
    if (ws.readyState === ws.OPEN) {
      ws.close(code, reason);
    }
    syncplaySocket.destroy();
  };

  syncplaySocket.on('connect', () => {
    connected = true;
    clearConnectTimer();
    ws.send(JSON.stringify({ Proxy: { connected: true } }) + '\r\n');
  });

  syncplaySocket.on('data', chunk => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk.toString('utf8'));
    }
  });

  syncplaySocket.on('error', error => {
    clearConnectTimer();
    const message = 'Could not connect to upstream server.';
    if (ws.readyState === ws.OPEN) {
      const errorPayload = JSON.stringify({ Error: { message } }) + '\r\n';
      ws.send(errorPayload, () => ws.close(1011, message.slice(0, 120)));
      return;
    }
    syncplaySocket.destroy();
    console.error('[syncplay-web-proxy] Upstream error:', error.message);
  });

  syncplaySocket.on('close', () => {
    clearConnectTimer();
    closeBoth(1000, 'Syncplay socket closed');
  });

  ws.on('message', message => {
    if (syncplaySocket.destroyed) {
      return;
    }
    syncplaySocket.write(typeof message === 'string' ? message : Buffer.from(message as Buffer));
  });

  ws.on('close', () => {
    syncplaySocket.destroy();
  });

  ws.on('error', () => {
    syncplaySocket.destroy();
  });
}
