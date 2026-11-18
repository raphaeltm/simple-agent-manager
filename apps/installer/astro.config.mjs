import { defineConfig } from 'astro/config';
export default defineConfig({
  vite: { build: { assetsInlineLimit: 0 } },
  outDir: './site-static',
  build: { format: 'file', inlineStylesheets: 'never' },
});
