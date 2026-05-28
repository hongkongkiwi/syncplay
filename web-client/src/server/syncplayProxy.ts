import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';

const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const MAX_PORT = 65535;

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

  const wss = new WebSocketServer({ noServer: true });

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

    wss.handleUpgrade(request, socket, head, ws => {
      bridgeSyncplay(ws, target.value, request);
    });
  });
}

type ProxyTarget = {
  host: string;
  port: number;
  tls: boolean;
};

type ParseResult = { ok: true; value: ProxyTarget } | { ok: false; error: string };

type ValidationResult = { ok: true } | { ok: false; error: string };

function validateOrigin(request: IncomingMessage): ValidationResult {
  const origin = request.headers.origin;
  if (!origin) {
    return { ok: true };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return { ok: false, error: 'Invalid WebSocket origin.' };
  }

  const allowedOrigins = (process.env.SYNCPLAY_WEB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter((value): value is string => !!value);

  if (allowedOrigins.includes('*') || allowedOrigins.includes(normalizedOrigin)) {
    return { ok: true };
  }

  const host = request.headers.host?.toLowerCase();
  if (host && normalizedOrigin === `http://${host}`) {
    return { ok: true };
  }
  if (host && normalizedOrigin === `https://${host}`) {
    return { ok: true };
  }

  return { ok: false, error: `Origin "${origin}" is not allowed.` };
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
    return {
      ok: false,
      error: `Host "${host}" is not allowed by SYNCPLAY_WEB_ALLOWED_HOSTS.`
    };
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
    const message = `Timed out connecting to ${target.host}:${target.port}.`;
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
    ws.send(JSON.stringify({ Proxy: { connected: true, remoteAddress: request.socket.remoteAddress } }) + '\r\n');
  });

  syncplaySocket.on('data', chunk => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk.toString('utf8'));
    }
  });

  syncplaySocket.on('error', error => {
    clearConnectTimer();
    const message = formatSocketError(error, target);
    if (ws.readyState === ws.OPEN) {
      const errorPayload = JSON.stringify({ Error: { message } }) + '\r\n';
      ws.send(errorPayload, () => ws.close(1011, message.slice(0, 120)));
      return;
    }
    syncplaySocket.destroy();
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

function formatSocketError(error: Error, target: ProxyTarget): string {
  if (error.message) {
    return error.message;
  }

  const causeMessages = (error as Error & { errors?: Error[] }).errors
    ?.map(cause => cause.message)
    .filter(Boolean);
  if (causeMessages?.length) {
    return causeMessages.join('; ');
  }

  return `Could not connect to ${target.host}:${target.port}.`;
}
