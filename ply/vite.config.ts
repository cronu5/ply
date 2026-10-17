import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4816' } },
  build: { rollupOptions: { output: { manualChunks: { scene: ['three'], chess: ['chess.js'] } } } },
});
