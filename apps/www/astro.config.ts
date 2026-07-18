import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { getBrandConfig } from './brand.config';

// Get brand configuration (can be customized via environment variables)
const brand = getBrandConfig();

export default defineConfig({
  site: process.env.SITE_URL || 'https://www.simple-agent-manager.org',
  server: {
    allowedHosts: true,
  },
  integrations: [
    starlight({
      title: brand.title,
      description: brand.description,
      logo: {
        src: brand.logoPath,
        replacesTitle: false,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: `https://github.com/${brand.githubOrg}/${brand.githubRepo}`,
        },
      ],
      editLink: {
        baseUrl: `https://github.com/${brand.githubOrg}/${brand.githubRepo}/edit/main/apps/www/`,
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
            { slug: 'docs/guides/idea-execution' },
            { slug: 'docs/guides/chat-features' },
            { slug: 'docs/guides/project-files' },
            { slug: 'docs/guides/recent-product-changes' },
            { slug: 'docs/guides/notifications' },
            { slug: 'docs/guides/webhook-triggers' },
            { slug: 'docs/guides/creating-workspaces' },
            { slug: 'docs/guides/app-deployments' },
            { slug: 'docs/guides/self-hosting' },
            { slug: 'docs/guides/local-development' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [{ slug: 'docs/architecture/overview' }, { slug: 'docs/architecture/security' }],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { slug: 'docs/reference/api' },
            { slug: 'docs/reference/vm-agent' },
            { slug: 'docs/reference/configuration' },
            { slug: 'docs/reference/cli-openapi' },
            { slug: 'docs/reference/contributing' },
            { slug: 'docs/reference/roadmap' },
          ],
        },
      ],
      customCss: [
        './src/styles/starlight-custom.css',
        // Include brand-specific CSS if configured
        ...(brand.customCssPath ? [brand.customCssPath] : []),
      ],
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
        {
          tag: 'script',
          attrs: {
            src: '/scripts/tracker.js',
            'data-api': `https://api.${process.env.PUBLIC_BASE_DOMAIN || 'simple-agent-manager.org'}/api/t`,
            defer: true,
          },
        },
        {
          tag: 'script',
          attrs: { type: 'module', src: '/scripts/docs-mermaid.js' },
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
