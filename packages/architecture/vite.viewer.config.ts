import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'dist/viewer',
    rollupOptions: {
      input: 'viewer.html',
    },
  },
  plugins: [react()],
});
