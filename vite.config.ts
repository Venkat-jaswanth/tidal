import { defineConfig } from 'vite';

// SharedArrayBuffer needs cross-origin isolation in dev and preview alike.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: { target: 'es2023' },
});
