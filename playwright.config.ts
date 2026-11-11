import { defineConfig } from '@playwright/test';

// Everything runs headed on the installed Chrome so WebGPU uses the real GPU.
export default defineConfig({
  testDir: 'tests',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: false,
    baseURL: 'http://localhost:5173',
    viewport: null,
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
