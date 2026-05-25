export function normalizeManagedRoomPassword(password: string): string {
  return password.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
}

export function generateManagedRoomPassword(): string {
  const letters = `${randomLetter()}${randomLetter()}`;
  return `${letters}-${randomDigits(3)}-${randomDigits(3)}`;
}

function randomLetter(): string {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

function randomDigits(length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += Math.floor(Math.random() * 10);
  }
  return value;
}
