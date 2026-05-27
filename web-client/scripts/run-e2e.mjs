import { spawn } from 'node:child_process';
import http from 'node:http';

const host = '127.0.0.1';
const port = 4173;
const baseUrl = `http://${host}:${port}`;

const server = spawn('pnpm', ['exec', 'vite', 'dev', '--host', host, '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env
});

let serverOutput = '';
server.stdout.on('data', chunk => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', chunk => {
  serverOutput += chunk.toString();
});

const stopServer = () => {
  if (!server.killed) {
    server.kill('SIGTERM');
  }
};

process.once('SIGINT', () => {
  stopServer();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopServer();
  process.exit(143);
});

try {
  await waitForServer(baseUrl, 30_000);
  const status = await runPlaywright();
  stopServer();
  process.exit(status);
} catch (error) {
  stopServer();
  console.error(error instanceof Error ? error.message : error);
  if (serverOutput.trim()) {
    console.error(serverOutput.trim());
  }
  process.exit(1);
}

function runPlaywright() {
  return new Promise(resolve => {
    const test = spawn('pnpm', ['exec', 'playwright', 'test'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl
      }
    });

    test.on('close', code => {
      resolve(code ?? 1);
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const statusCode = await request(url);
      if (statusCode && statusCode >= 200 && statusCode < 500) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, response => {
      response.resume();
      response.once('end', () => {
        resolve(response.statusCode);
      });
    });
    req.setTimeout(2_000, () => {
      req.destroy(new Error('Request timed out.'));
    });
    req.once('error', reject);
  });
}
