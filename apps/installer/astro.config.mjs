import { defineConfig } from 'astro/config';
export default defineConfig({
  // Astro 7 defaults to 'jsx', which drops the newline between an inline element and the
  // next word in templates ("<code>x</code>⏎but" renders "xbut"). Keep HTML-aware compression.
  compressHTML: true,
  vite: { build: { assetsInlineLimit: 0 } },
  outDir: './site-static',
  build: { format: 'file', inlineStylesheets: 'never' },
});
