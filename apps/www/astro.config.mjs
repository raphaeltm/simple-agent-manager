import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: process.env.SITE_URL || 'https://www.simple-agent-manager.org',
  integrations: [sitemap()],
  build: {
    assets: '_assets',
  },
  markdown: {
    shikiConfig: {
      theme: 'night-owl',
    },
  },
});
