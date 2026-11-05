import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // HOST=0.0.0.0 npm run dev exposes the dev server to your phone on the LAN.
    host: process.env.HOST ?? '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
