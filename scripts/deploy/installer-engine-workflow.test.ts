import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> }>;
  jobs: Record<
    string,
    {
      if?: string;
      with?: Record<string, unknown>;
      outputs?: Record<string, string>;
      steps?: Step[];
    }
  >;
}
const load = (file: string) => parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as Workflow;
const reusable = load('deploy-reusable.yml');
const steps = reusable.jobs.deploy?.steps ?? [];
const boundary = steps.findIndex(
  (step) => step.name === 'Create Pulumi State Bucket (if not exists)'
);
function active(step: Step, shared: boolean, dry: boolean): boolean {
  let expression = (step.if ?? 'true').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  expression = expression
    .replace(/inputs\.use_shared_engine/g, String(shared))
    .replace(/inputs\.dry_run/g, String(dry))
    .replace(/inputs\.environment/g, "'staging'")
    .replace(/steps\.first_deploy\.outputs\.is_first/g, "'true'")
    .replace(/steps\.first_deploy\.outputs\.needs_tail_sync/g, "'true'")
    .replace(/always\(\)/g, 'true');
  if (/[^\w\s'!&|=().-]/.test(expression)) throw new Error('Unexpected workflow route expression');
  // Evaluate trusted repository workflow boolean conditions, never user input.
  return Boolean(new Function(`return (${expression});`)());
}

describe('shared deployment workflow routing', () => {
  it('requires explicit opt-in and leaves production callers on the legacy default', () => {
    expect(reusable.on.workflow_call?.inputs?.use_shared_engine).toMatchObject({
      type: 'boolean',
      default: false,
    });
    const staging = load('deploy-staging.yml');
    expect(staging.on.workflow_dispatch?.inputs?.use_shared_engine).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(staging.jobs.deploy?.with?.use_shared_engine).toBe(
      '${{ inputs.use_shared_engine || false }}'
    );
    const production = load('deploy.yml');
    expect(production.on.workflow_dispatch?.inputs).not.toHaveProperty('use_shared_engine');
    expect(production.jobs.deploy?.with).not.toHaveProperty('use_shared_engine');
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('routes exactly one mutation implementation (shared=%s, preview=%s)', (shared, dry) => {
    expect(boundary).toBeGreaterThan(0);
    const engine = steps.find((step) => step.id === 'shared_engine');
    expect(engine).toBeDefined();
    expect(active(engine ?? {}, shared, dry)).toBe(shared);
    const legacy = steps.slice(boundary);
    expect(legacy.length).toBeGreaterThan(20);
    for (const step of legacy) {
      expect(step.if).toContain('!inputs.use_shared_engine');
      if (shared) expect(active(step, shared, dry)).toBe(false);
    }
    if (!shared) {
      expect(active(legacy.find((step) => step.name === 'Pulumi Up') ?? {}, shared, dry)).toBe(
        !dry
      );
      expect(active(legacy.find((step) => step.name === 'Pulumi Preview') ?? {}, shared, dry)).toBe(
        dry
      );
    }
    const gate = steps.find(
      (step) => step.name === 'Verify installation engine orchestration contract'
    );
    expect(gate?.if).toBeUndefined();
    expect(gate?.run).toContain('installer-engine.vitest.config.ts');
  });
  it('retains output contracts and sends existing secrets only through private environment', () => {
    expect(reusable.jobs.deploy?.outputs?.api_url).toBe(
      '${{ steps.shared_engine.outputs.api_url || steps.output.outputs.api_url }}'
    );
    expect(reusable.jobs.deploy?.outputs?.app_url).toBe(
      '${{ steps.shared_engine.outputs.app_url || steps.output.outputs.app_url }}'
    );
    const engine = steps.find((step) => step.id === 'shared_engine');
    const privateJson = engine?.env?.SAM_CI_SECRETS_JSON ?? '';
    expect(privateJson).not.toContain('toJSON(secrets)');
    const manifest = readFileSync('scripts/deploy/installer-engine-ci-env.json', 'utf8');
    const required = [
      ...new Set([...manifest.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((match) => match[1])),
    ].sort();
    const supplied = [...privateJson.matchAll(/toJSON\(secrets\.([A-Z_0-9]+)\)/g)]
      .map((match) => match[1])
      .sort();
    expect(supplied).toEqual(required);
    expect(
      JSON.parse(
        privateJson.replace(
          /\$\{\{ toJSON\(secrets\.[A-Z_0-9]+\) \}\}/g,
          JSON.stringify('quote"\nsecret')
        )
      )
    ).toHaveProperty('CF_API_TOKEN', 'quote"\nsecret');
    expect(engine?.run).toContain('installer-engine-ci-cli.ts');
    expect(engine?.run).not.toContain('SAM_CI_SECRETS_JSON');
    expect(engine?.run).not.toMatch(/echo.*secrets|upload-artifact/);
    expect(engine?.env?.SAM_CI_SOURCE_COMMIT).toBe('${{ steps.deploy-sha.outputs.value }}');
    expect(
      active(steps.find((step) => step.name === 'Setup Go for Shared Engine') ?? {}, true, false)
    ).toBe(true);
    expect(
      active(steps.find((step) => step.name === 'Setup Go for Shared Engine') ?? {}, true, true)
    ).toBe(false);
  });
  it('preserves manual fork self-hosting and existing automatic production trust checks', () => {
    const staging = load('deploy-staging.yml');
    expect(Object.keys(staging.on)).toEqual(['workflow_dispatch']);
    expect(String(staging.jobs.deploy?.if)).not.toContain('github.repository');
    const production = load('deploy.yml');
    const automatic = production.jobs['validate-automatic-dispatch'];
    expect(automatic?.if).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository'
    );
    expect(automatic?.if).toContain("github.event.workflow_run.event == 'push'");
    expect(automatic?.if).toContain("github.event.workflow_run.head_branch == 'main'");
  });
});
