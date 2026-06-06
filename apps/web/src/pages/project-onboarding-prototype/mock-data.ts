/**
 * Mock data for the "project onboarding" prototype.
 *
 * Stress-test the layout with long names, many items, special characters,
 * single-character names, and empty descriptions. No API — prototype only.
 */

export interface MockRepo {
  id: number;
  fullName: string;
  description: string;
  defaultBranch: string;
  /** Selectable branches for this repo — branch choice is required during onboarding. */
  branches: string[];
  language: string;
  private: boolean;
  pushedAt: string;
}

export const MOCK_REPOS: MockRepo[] = [
  {
    id: 1,
    fullName: 'raphaeltm/simple-agent-manager',
    description: 'Serverless platform for ephemeral AI coding agent environments',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'sam/lets-imagine-better-project-01kteg', 'staging'],
    language: 'TypeScript',
    private: false,
    pushedAt: '2 hours ago',
  },
  {
    id: 2,
    fullName: 'acme-corp/billing-service',
    description: 'Stripe-backed billing and metering for the core product',
    defaultBranch: 'develop',
    branches: ['develop', 'main', 'release/2026-q2'],
    language: 'Go',
    private: true,
    pushedAt: 'yesterday',
  },
  {
    id: 3,
    fullName: 'acme-corp/marketing-site',
    description: '',
    defaultBranch: 'main',
    branches: ['main'],
    language: 'Astro',
    private: false,
    pushedAt: '3 days ago',
  },
  {
    id: 4,
    fullName: 'acme-corp/very-long-monorepo-name-that-keeps-going-internal-platform-tools',
    description:
      'A deliberately over-long description used to verify that the repository card wraps gracefully on the narrowest supported viewport without clipping or horizontal overflow, even when the maintainer never learned the value of brevity.',
    defaultBranch: 'release/2026-q2-stabilization-branch',
    branches: [
      'release/2026-q2-stabilization-branch',
      'main',
      'feature/an-extremely-long-branch-name-used-to-verify-the-dropdown-truncates-rather-than-overflowing',
    ],
    language: 'Rust',
    private: true,
    pushedAt: 'last week',
  },
  {
    id: 5,
    fullName: 'oss/x',
    description: 'Single-char repo',
    defaultBranch: 'main',
    branches: ['main'],
    language: 'C',
    private: false,
    pushedAt: '1 month ago',
  },
  {
    id: 6,
    fullName: 'oss/emoji-playground-🎮',
    description: 'Unicode & emoji in names: 日本語 — <script>alert(1)</script>',
    defaultBranch: 'main',
    branches: ['main', '日本語-ブランチ'],
    language: 'JavaScript',
    private: false,
    pushedAt: '2 months ago',
  },
  {
    id: 7,
    fullName: 'data-team/etl-pipelines',
    description: 'Airflow DAGs and dbt models for the analytics warehouse',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'experiment/dbt-1.8-upgrade'],
    language: 'Python',
    private: true,
    pushedAt: '4 hours ago',
  },
  {
    id: 8,
    fullName: 'design-system/tokens',
    description: 'Shared design tokens and primitives',
    defaultBranch: 'main',
    branches: ['main', 'next'],
    language: 'CSS',
    private: false,
    pushedAt: '5 days ago',
  },
];

/** Derive a friendly project name from a repo full name (owner/repo → repo). */
export function deriveProjectName(fullName: string): string {
  const repo = fullName.split('/').pop() ?? fullName;
  return repo
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
