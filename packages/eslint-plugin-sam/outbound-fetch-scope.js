/**
 * Source that runs in the API Worker, where sam/no-unguarded-outbound-fetch applies: the worker
 * itself and every package it bundles (worker modularization, #2681). Tests are excluded.
 * Shared by eslint.config.mjs and scripts/outbound-fetch-baseline.mjs so both see the same files.
 */
export const OUTBOUND_FETCH_GUARD_FILES = [
  'apps/api/src/**/*.ts',
  ...[
    'agent-email',
    'ai-proxy',
    'app-deployment',
    'operations',
    'project-data',
    'providers',
    'repo-hosting',
    'scheduler-core',
    'worker-core',
  ].map((name) => `packages/${name}/src/**/*.ts`),
];
