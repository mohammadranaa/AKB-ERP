import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the client calls /api on the same origin and Vite forwards it to the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // AKB_LAN=true lets phones on the same Wi-Fi open the system (tools/start.sh --lan).
    host: process.env.AKB_LAN === 'true' ? '0.0.0.0' : '127.0.0.1',
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:4000', changeOrigin: false } }
  },
  build: { outDir: 'dist', sourcemap: false }
});
