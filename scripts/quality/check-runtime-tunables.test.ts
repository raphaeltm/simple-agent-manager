import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import {
  findNewTunables,
  scalarEnvironmentNames,
  workerVariableNames,
} from './check-runtime-tunables';

describe('runtime tunable ratchet', () => {
  it('rejects untyped vars introduced only in named Worker environments', () => {
    const names = workerVariableNames({
      vars: { EXISTING: 'yes' },
      env: {
        staging: { vars: { STAGING_LIMIT: 20, EXISTING: 'override' } },
        production: { vars: { PRODUCTION_SWITCH: true } },
        preview: { name: 'preview' },
      },
    });
    expect(names).toEqual(['EXISTING', 'PRODUCTION_SWITCH', 'STAGING_LIMIT']);
    expect(findNewTunables(names, ['EXISTING'], {})).toEqual([
      'PRODUCTION_SWITCH',
      'STAGING_LIMIT',
    ]);
  });
  it('includes inherited and aliased scalar controls while excluding resource bindings', () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { strictNullChecks: true },
    });
    project.createSourceFile('/base.ts', 'export interface Base { INHERITED?: string; }');
    project.createSourceFile(
      '/env.ts',
      `import type { Base } from './base';
      type Setting = 'on' | 'off';
      export interface Env extends Base {
        LOCAL?: Setting; COUNT: number; FLAG: boolean;
        DATABASE: { prepare(sql: string): unknown }; KV?: { get(key: string): Promise<string> };
      }`
    );
    expect(scalarEnvironmentNames(project, '/env.ts')).toEqual([
      'COUNT',
      'FLAG',
      'INHERITED',
      'LOCAL',
    ]);
  });

  it('rejects new controls, allowing only existing names or justified bootstrap exceptions', () => {
    expect(
      findNewTunables(['OLD', 'NEW_LIMIT', 'RESOURCE_ID', 'EMPTY_REASON'], ['OLD'], {
        RESOURCE_ID: 'Cloudflare resource identifier required before D1 can be opened.',
        EMPTY_REASON: ' ',
      })
    ).toEqual(['NEW_LIMIT', 'EMPTY_REASON']);
  });
});
