# Brand Customization Guide

This guide explains how to customize the SAM documentation website with your own branding while keeping the setup merge-friendly with upstream changes.

## Overview

The branding system allows you to override the default SAM branding using:
1. **Environment variables** - Configure brand name, title, GitHub links, etc.
2. **Custom logo** - Add your own logo file
3. **Custom CSS** - Override theme colors with your brand colors

This approach is designed to minimize merge conflicts when syncing with upstream SAM.

## Quick Start

### 1. Set Environment Variables

Create a `.env` file in `apps/www/`:

```bash
BRAND_NAME=YourOrg
BRAND_TITLE=YourOrg SAM Docs
BRAND_GITHUB_ORG=yourorg
BRAND_LOGO_PATH=./src/assets/logo-yourorg.png
BRAND_CUSTOM_CSS=./src/styles/brand-yourorg.css
```

### 2. Add Your Logo

Place your logo in `apps/www/src/assets/logo-yourorg.png`

### 3. Create Brand Theme CSS

Create `apps/www/src/styles/brand-yourorg.css` with your color overrides:

```css
:root {
  /* Dark theme colors */
  --sl-color-accent-low: #your-color;
  --sl-color-accent: #your-color;
  --sl-color-accent-high: #your-color;
  /* ... other color variables */
}

:root[data-theme='light'] {
  /* Light theme colors */
  --sl-color-accent-low: #your-color;
  --sl-color-accent: #your-color;
  --sl-color-accent-high: #your-color;
  /* ... other color variables */
}
```

## Available Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAND_NAME` | Organization name | `SAM` |
| `BRAND_TITLE` | Documentation site title | `SAM Docs` |
| `BRAND_DESCRIPTION` | Site description | Default SAM description |
| `BRAND_GITHUB_ORG` | GitHub organization | `raphaeltm` |
| `BRAND_GITHUB_REPO` | GitHub repository | `simple-agent-manager` |
| `BRAND_LOGO_PATH` | Logo file path (relative to `src/assets/`) | `./src/assets/logo.png` |
| `BRAND_CUSTOM_CSS` | Custom CSS file path (relative to `src/styles/`) | (none) |

## Example: Defang Branding

The Defang fork uses this configuration:

**.env**:
```bash
BRAND_NAME=Defang
BRAND_TITLE=Defang SAM Docs
BRAND_GITHUB_ORG=defanglabs
BRAND_LOGO_PATH=./src/assets/logo-defang.png
BRAND_CUSTOM_CSS=./src/styles/brand-defang.css
```

Files created:
- `apps/www/src/assets/logo-defang.png` - Defang logo
- `apps/www/src/styles/brand-defang.css` - Defang purple-blue theme

## Merge-Friendly Architecture

This system is designed to avoid merge conflicts:

### ✅ Files Safe from Upstream Conflicts

These files are fork-specific and won't conflict:
- `.env` (gitignored, never committed)
- `src/assets/logo-yourorg.png` (your custom logo)
- `src/styles/brand-yourorg.css` (your custom theme)
- `.env.example` (documents options, minimal conflicts)

### ⚠️ Files with Minimal Upstream Changes

These files have small, isolated changes:
- `astro.config.ts` - Imports `getBrandConfig()` and uses brand variables
- `brand.config.ts` - New file that won't exist upstream

### 🔄 Syncing with Upstream

When you sync with upstream SAM:

1. **Pull upstream changes**:
   ```bash
   git fetch upstream
   git merge upstream/main
   ```

2. **Resolve conflicts** (if any):
   - `astro.config.ts` - The only file likely to conflict
   - Conflicts will be in the sidebar config or other non-brand sections
   - Your brand variables (`brand.title`, etc.) won't conflict

3. **Your branding persists**:
   - `.env` is gitignored and never touched
   - Your logo and CSS files are unique to your fork
   - The brand config system continues to work

## Color Variables Reference

Starlight uses these CSS custom properties for theming:

### Accent Colors
- `--sl-color-accent-low` - Low-intensity accent (backgrounds)
- `--sl-color-accent` - Primary accent (links, highlights)
- `--sl-color-accent-high` - High-intensity accent (hover states)

### Gray Scale
- `--sl-color-white` - Lightest gray
- `--sl-color-gray-1` through `--sl-color-gray-6` - Gray scale steps
- `--sl-color-black` - Darkest gray / background

Define these separately for `:root` (dark theme) and `:root[data-theme='light']` (light theme).

## Testing Your Branding

1. **Start the dev server**:
   ```bash
   cd apps/www
   npm run dev
   ```

2. **Check the site** at `http://localhost:4321/docs/overview`

3. **Verify**:
   - Logo appears correctly
   - Colors match your brand
   - GitHub links point to your organization
   - Title shows your branding

## Deployment

For production deployments, set the environment variables in your hosting platform:

**Cloudflare Pages**:
```bash
wrangler pages deployment create --env=production \
  --var BRAND_NAME=YourOrg \
  --var BRAND_TITLE="YourOrg SAM Docs" \
  ...
```

**Vercel**:
Add environment variables in the Vercel dashboard or `vercel.json`

**Netlify**:
Add environment variables in the Netlify dashboard or `netlify.toml`

## Troubleshooting

**Logo not showing**: Check that `BRAND_LOGO_PATH` points to a valid file

**Colors not applying**: Ensure `BRAND_CUSTOM_CSS` points to your CSS file and the file exists

**Links incorrect**: Verify `BRAND_GITHUB_ORG` and `BRAND_GITHUB_REPO` are set correctly

**Changes not appearing**: Restart the dev server after changing `.env`
