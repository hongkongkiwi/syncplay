export type ServerAddress = {
  host: string;
  port: number;
};

export type PublicServerOption = {
  label: string;
  address: string;
};

export const DEFAULT_SYNCPLAY_PORT = 8999;

export const PUBLIC_SERVER_OPTIONS: PublicServerOption[] = [
  { label: 'syncplay.pl:8995 (France)', address: 'syncplay.pl:8995' },
  { label: 'syncplay.pl:8996 (France)', address: 'syncplay.pl:8996' },
  { label: 'syncplay.pl:8997 (France)', address: 'syncplay.pl:8997' },
  { label: 'syncplay.pl:8998 (France)', address: 'syncplay.pl:8998' },
  { label: 'syncplay.pl:8999 (France)', address: 'syncplay.pl:8999' }
];

export function parseServerAddress(value: string): ServerAddress | null {
  const cleaned = value.replace(/\s/g, '');
  if (!cleaned) {
    return null;
  }

  const parsed = parseAsUrl(cleaned) ?? parseHostPort(cleaned);
  if (!parsed || !isValidHost(parsed.host) || !isValidPort(parsed.port)) {
    return null;
  }

  return parsed;
}

export function formatServerAddress(address: ServerAddress): string {
  return `${address.host}:${address.port}`;
}

function parseAsUrl(value: string): ServerAddress | null {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return null;
  }

  try {
    const url = new URL(value);
    if (!url.hostname) {
      return null;
    }

    return {
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : DEFAULT_SYNCPLAY_PORT
    };
  } catch {
    return null;
  }
}

function parseHostPort(value: string): ServerAddress | null {
  if (value.startsWith('[')) {
    const endBracket = value.indexOf(']');
    if (endBracket === -1) {
      return null;
    }

    const host = value.slice(0, endBracket + 1);
    const suffix = value.slice(endBracket + 1);
    if (!suffix) {
      return { host, port: DEFAULT_SYNCPLAY_PORT };
    }
    if (!suffix.startsWith(':')) {
      return null;
    }

    return { host, port: Number.parseInt(suffix.slice(1), 10) };
  }

  const parts = value.split(':');
  if (parts.length === 1) {
    return { host: value, port: DEFAULT_SYNCPLAY_PORT };
  }
  if (parts.length === 2) {
    return {
      host: parts[0] ?? '',
      port: Number.parseInt(parts[1] ?? '', 10)
    };
  }

  return { host: `[${value}]`, port: DEFAULT_SYNCPLAY_PORT };
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidHost(host: string): boolean {
  return host.trim().length > 0 && host !== '[]';
}
