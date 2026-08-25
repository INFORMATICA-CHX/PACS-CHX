import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  // The Manager is loaded from a local Electron file, so generated asset
  // URLs must be relative. They also work when the Viewer is served by Express.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      input: {
        viewer: fileURLToPath(new URL('./index.html', import.meta.url)),
        manager: fileURLToPath(new URL('./manager.html', import.meta.url)),
      },
    },
  },
});
