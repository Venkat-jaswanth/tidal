import { defineConfig } from '@playwright/test';

// Everything runs headed on the installed Chrome so WebGPU uses the real GPU.
// Tests use their own dev server on 5174 with hot reload off, so editing files never reloads a page mid-test.
const url = process.env.TIDAL_URL ?? 'http://localhost:5174';

export default defineConfig({
  testDir: 'tests',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: false,
    baseURL: url,
    viewport: null,
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
  webServer: {
    command: 'npx vite',
    env: { TIDAL_PORT: '5174', TIDAL_NO_HMR: '1' },
    url,
    reuseExistingServer: true,
  },
});
