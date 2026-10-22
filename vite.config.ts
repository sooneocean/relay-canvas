import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], build: { outDir: 'dist', chunkSizeWarningLimit: 800 }, server: { host: '127.0.0.1' } });
