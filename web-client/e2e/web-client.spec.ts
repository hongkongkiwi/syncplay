import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';

test('renders the browser client and handles local media selection', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await expect(page.getByRole('heading', { name: 'Join a watch room from the browser.' })).toBeVisible();
  await expect(page.getByText('idle')).toBeVisible();
  await expect(page.getByLabel('Host')).toHaveValue('localhost');
  await expect(page.getByLabel('Port')).toHaveValue('8999');
  await expect(page.getByLabel('Name')).toHaveValue('WebGuest');
  await expect(page.getByLabel('Room')).toHaveValue('default');

  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'fixture.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
  });

  await expect(page.locator('video')).toBeVisible();
  await expect(page.getByText('Loaded fixture.mp4.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sync now/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Not ready/ })).toBeDisabled();
});

test('validates the port before opening a proxy socket', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const port = page.getByLabel('Port');
  await port.fill('70000');
  await expect(port).toHaveValue('70000');
  await page.getByRole('button', { name: /Connect/ }).click();

  await expect(page.getByText('Port must be an integer between 1 and 65535.')).toBeVisible();
  await expect(page.getByText('error')).toBeVisible();
});

test('rejects proxy upgrades to disallowed Syncplay hosts', async ({ baseURL }) => {
  const status = await attemptProxyUpgrade(`${baseURL}/syncplay-proxy?host=example.com&port=8999&tls=0`);

  expect(status).toBe(403);
});

function attemptProxyUpgrade(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Origin: new URL(url).origin
      }
    });

    socket.once('open', () => {
      socket.close();
      reject(new Error('Proxy accepted a disallowed host.'));
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
    });
    socket.once('error', error => {
      reject(error);
    });
  });
}
