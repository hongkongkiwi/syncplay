export function parseTimestamp(value: string): number | null {
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned.split(':');
  if (parts.some(part => !/^\d+$/.test(part))) {
    return null;
  }

  const numbers = parts.map(part => Number.parseInt(part, 10));
  if (numbers.some(number => !Number.isFinite(number))) {
    return null;
  }

  return numbers.reduce((total, part) => total * 60 + part, 0);
}
