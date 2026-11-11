import { defineConfig } from 'vite';

// SharedArrayBuffer needs cross-origin isolation in dev and preview alike.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// TIDAL_PORT and TIDAL_NO_HMR give test tools a second dev server that never reloads pages mid-run.
const port = Number(process.env.TIDAL_PORT ?? 5173);

export default defineConfig({
  server: { port, strictPort: true, headers: isolation, hmr: process.env.TIDAL_NO_HMR ? false : undefined },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: { target: 'es2023' },
});
