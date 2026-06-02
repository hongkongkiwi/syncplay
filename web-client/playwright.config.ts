import { defineConfig, devices } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  webServer: {
    command: 'npm run dev',
    port: 4173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome']
    },
    {
      name: 'firefox',
      use: devices['Desktop Firefox']
    },
    {
      name: 'webkit',
      use: devices['Desktop Safari']
    }
  ]
});
