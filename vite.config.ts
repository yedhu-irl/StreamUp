import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      crypto: 'crypto-browserify',
      'telegram/CryptoFile': path.resolve(__dirname, 'src/shims/CryptoFile.ts'),
    },
  },
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    port: 3000,
    host: true,
  },
  build: {
    target: 'esnext',
  },
});
