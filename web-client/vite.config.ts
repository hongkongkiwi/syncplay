import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
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
      '~': new URL('./src', import.meta.url).pathname
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
