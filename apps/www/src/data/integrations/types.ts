/**
 * Types for the /integrations/ hub and /integrations/[slug]/ detail pages.
 *
 * Claims in these files must match the code. Each entry cites where a fact comes from when it is
 * not obvious, and tests/integrations-catalog.test.ts checks the agent list and model names
 * against packages/shared so a new agent or a renamed model cannot leave the page stale.
 */

export type IntegrationCategory = 'ai-agents' | 'cloud-providers' | 'code-hosting' | 'model-access';

export interface Integration {
  slug: string;
  name: string;
  shortName?: string;
  category: IntegrationCategory;
  tagline: string;
  description: string;
  /** Path to the logo image file in /images/integrations/ */
  logoPath: string;
  /** SEO page title */
  seoTitle: string;
  /** SEO meta description (max ~155 chars) */
  seoDescription: string;
  features: Array<{ title: string; description: string }>;
  howItWorks: Array<{ step: string; description: string }>;
  useCases: Array<{ title: string; description: string }>;
  faq: Array<{ question: string; answer: string }>;
  relatedSlugs: string[];
  /** The vendor's own page for this technology */
  externalUrl: string;
  /** Label for the external link, e.g. "Claude Code docs" or "Hetzner Cloud website" */
  externalLabel: string;
  /** Example models shown as badges. Names must exist in packages/shared/src/model-catalog.ts. */
  models?: string[];
  /** SAM docs page that covers setup in detail */
  docsPath?: string;
}

/** A shipped capability that has a docs page but no integration detail page. */
export interface ConnectionLink {
  name: string;
  description: string;
  /** SAM docs path */
  href: string;
  icon:
    | 'clock'
    | 'github'
    | 'webhook'
    | 'mail'
    | 'plug'
    | 'chat'
    | 'key'
    | 'bell'
    | 'container'
    | 'rocket'
    | 'gauge'
    | 'route';
}

export interface IntegrationSection {
  id: IntegrationCategory | 'automation' | 'connect';
  label: string;
  question: string;
  description: string;
}

const CATEGORIES: readonly IntegrationCategory[] = [
  'ai-agents',
  'cloud-providers',
  'code-hosting',
  'model-access',
];

/**
 * Validate integration content loaded from JSON (content, not code, like data/features/*.json),
 * so a typo in a category or a missing step fails the build instead of rendering a broken page.
 */
export function asIntegration(candidate: unknown): Integration {
  const entry = candidate as Integration;
  if (!CATEGORIES.includes(entry.category)) {
    throw new Error(`Integration "${entry.slug}" has unknown category "${entry.category}"`);
  }
  if (entry.howItWorks.length === 0 || entry.features.length === 0) {
    throw new Error(`Integration "${entry.slug}" needs at least one feature and one setup step`);
  }
  if (!entry.externalLabel || !entry.logoPath.startsWith('/images/integrations/')) {
    throw new Error(
      `Integration "${entry.slug}" needs an external link label and a logo under /images/integrations/`
    );
  }
  return entry;
}
