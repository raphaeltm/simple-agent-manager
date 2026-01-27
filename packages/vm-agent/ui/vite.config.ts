import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Output to dist for embedding in Go binary
    outDir: 'dist',
    // Generate smaller chunks for embedding
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Simple naming for embedded assets
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
    // Minify for production
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
  },
  // Development server config
  server: {
    port: 3001,
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/terminal': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
