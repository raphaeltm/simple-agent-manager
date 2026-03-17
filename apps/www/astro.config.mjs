import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: process.env.SITE_URL || 'https://www.simple-agent-manager.org',
  integrations: [
    starlight({
      title: 'SAM Docs',
      description:
        'Documentation for Simple Agent Manager — ephemeral AI coding environments on Cloudflare Workers + multi-cloud VMs.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/raphaeltm/simple-agent-manager',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/raphaeltm/simple-agent-manager/edit/main/apps/www/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { slug: 'docs/overview' },
            { slug: 'docs/quickstart' },
            { slug: 'docs/concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'docs/guides/agents' },
            { slug: 'docs/guides/task-execution' },
            { slug: 'docs/guides/chat-features' },
            { slug: 'docs/guides/notifications' },
            { slug: 'docs/guides/creating-workspaces' },
            { slug: 'docs/guides/self-hosting' },
            { slug: 'docs/guides/local-development' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [
            { slug: 'docs/architecture/overview' },
            { slug: 'docs/architecture/security' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { slug: 'docs/reference/api' },
            { slug: 'docs/reference/vm-agent' },
            { slug: 'docs/reference/configuration' },
          ],
        },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preload',
            href: '/fonts/Chillax-Variable.woff2',
            as: 'font',
            type: 'font/woff2',
            crossorigin: '',
          },
        },
      ],
      disable404Route: true,
    }),
    sitemap(),
  ],
  build: {
    assets: '_assets',
  },
  markdown: {
    shikiConfig: {
      theme: 'night-owl',
    },
  },
});
