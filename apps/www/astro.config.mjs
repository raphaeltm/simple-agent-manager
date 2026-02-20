import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://simple-agent-manager.org',
  integrations: [sitemap()],
  build: {
    assets: '_assets',
  },
});
