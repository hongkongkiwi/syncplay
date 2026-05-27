import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { syncplayProxyPlugin } from './src/server/syncplayProxy';

export default defineConfig({
  server: {
    port: 3000
  },
  preview: {
    port: 3000
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  plugins: [
    syncplayProxyPlugin(),
    tanstackStart({
      srcDirectory: 'src'
    }),
    viteReact(),
    nitro()
  ]
});
