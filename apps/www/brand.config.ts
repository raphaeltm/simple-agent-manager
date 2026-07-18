/**
 * Brand Configuration Override
 *
 * This file provides brand-specific overrides for the SAM documentation site.
 * It's designed to be fork-friendly and won't conflict with upstream changes.
 *
 * Environment variables can be used to customize:
 * - BRAND_NAME: Organization name (e.g., "Defang")
 * - BRAND_TITLE: Site title (e.g., "Defang SAM Docs")
 * - BRAND_DESCRIPTION: Site description
 * - BRAND_GITHUB_ORG: GitHub organization (e.g., "defanglabs")
 * - BRAND_LOGO_PATH: Path to logo file (relative to src/assets/)
 * - BRAND_CUSTOM_CSS: Path to custom CSS file (relative to src/styles/)
 */

export interface BrandConfig {
  name: string;
  title: string;
  description: string;
  githubOrg: string;
  githubRepo: string;
  logoPath: string;
  customCssPath?: string;
}

/**
 * Default SAM branding (upstream)
 */
const DEFAULT_BRAND: BrandConfig = {
  name: 'SAM',
  title: 'SAM Docs',
  description:
    'Documentation for Simple Agent Manager — ephemeral AI coding environments on Cloudflare Workers + multi-cloud VMs.',
  githubOrg: 'raphaeltm',
  githubRepo: 'simple-agent-manager',
  logoPath: './src/assets/logo.png',
};

/**
 * Get brand configuration from environment or defaults
 */
export function getBrandConfig(): BrandConfig {
  const brandName = process.env.BRAND_NAME;

  // If no brand customization is set, use defaults
  if (!brandName) {
    return DEFAULT_BRAND;
  }

  // Build branded config from environment
  return {
    name: brandName,
    title: process.env.BRAND_TITLE || `${brandName} SAM Docs`,
    description: process.env.BRAND_DESCRIPTION ||
      `Documentation for ${brandName} Simple Agent Manager — ephemeral AI coding environments on Cloudflare Workers + multi-cloud VMs.`,
    githubOrg: process.env.BRAND_GITHUB_ORG || DEFAULT_BRAND.githubOrg,
    githubRepo: process.env.BRAND_GITHUB_REPO || DEFAULT_BRAND.githubRepo,
    logoPath: process.env.BRAND_LOGO_PATH || DEFAULT_BRAND.logoPath,
    customCssPath: process.env.BRAND_CUSTOM_CSS,
  };
}
