/**
 * Emptying .state when something in it cannot be removed (box round R12: the Go module cache's
 * read-only directories). The secrets must already be gone, and the summary must say exactly what
 * is left. teardown.test.ts covers the real read-only tree through the real entry point; here a
 * removal failure that no chmod can fix (another owner's file) is injected, through the same
 * items and executor teardown.ts runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { boxItems, type TeardownContext } from './teardown-box';
import { execute, renderSummary } from './teardown-model';
import { clearStateEntries, removeTree } from './teardown-state-dir';

let root: string;
let state: string;

function seedState(): void {
  mkdirSync(join(state, 'key-agent', 'bundles'), { recursive: true });
  writeFileSync(join(state, 'key-agent', 'kek'), 'fake-key-material');
  writeFileSync(join(state, 'key-agent', 'bundles', 'b1.sealed'), 'fake-sealed');
  writeFileSync(join(state, 'secrets.env'), 'BOOTSTRAP_OWNER_EMAIL=owner@example.com\n');
  mkdirSync(join(state, 'go-cache', 'mod'), { recursive: true });
  writeFileSync(join(state, 'go-cache', 'mod', 'x'), 'cache');
  mkdirSync(join(state, 'project'), { recursive: true });
}

function context(remove: (path: string) => void): TeardownContext {
  const recordFile = join(state, 'created-resources.json');
  addResource(recordFile, {
    cloud: 'box',
    kind: 'state-dir',
    name: state,
    action: 'created',
    createdBy: 'deploy',
    attributes: {},
  });
  return {
    box: {},
    envFile: join(root, '.env'),
    stateDir: state,
    composeFiles: [],
    // No docker here: volume listing fails, so no volume items.
    run: () => ({ status: 1, stdout: '', stderr: 'no docker' }),
    now: () => 0,
    log: () => {},
    mode: 'remove-everything',
    options: { deleteBackups: false, destroyKey: true, adoptDiscovered: false, gcpProjects: [] },
    record: [
      {
        cloud: 'box',
        kind: 'state-dir',
        name: state,
        action: 'created',
        createdBy: 'deploy',
        attributes: {},
      },
    ],
    recordFile,
    domain: 'sam.example.com',
    installationId: null,
    selfhostDir: join(root, 'checkout', 'deploy', 'selfhost'),
    removeTree: remove,
  };
}

const failOn = (name: string) => (path: string) => {
  if (path.endsWith(name)) throw new Error(`EPERM: operation not permitted, rmdir '${path}'`);
  removeTree(path);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'teardown-state-'));
  state = join(root, '.state');
  mkdirSync(state);
  seedState();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('emptying .state when an entry cannot be removed', () => {
  it('removes the secrets first and names the cache that is left', () => {
    const ctx = context(failOn('go-cache'));
    const outcomes = execute(
      boxItems(ctx).filter((i) => i.id.startsWith('box:key') || i.id === 'box:state'),
      'remove-everything',
      ctx.recordFile
    );
    // Secrets and bundles are gone; only the cache and the record remain.
    expect(readdirSync(state).sort()).toEqual(['created-resources.json', 'go-cache']);
    const byId = new Map(outcomes.map((o) => [o.item.id, o]));
    expect(byId.get('box:key-file')?.status).toBe('removed');
    const stateOutcome = byId.get('box:state');
    expect(stateOutcome?.status).toBe('failed');
    expect(stateOutcome?.why).toContain(`${join(state, 'go-cache')} (a build cache, no secrets)`);
    expect(stateOutcome?.why).toContain('including the sealed bundles and key material');
    expect(stateOutcome?.why).toContain('chmod -R u+w');
    const summary = renderSummary(outcomes);
    expect(summary).toMatch(/Removed:\n {2}- key file /);
    expect(summary).toMatch(/Failed:\n {2}- .*\.state .*go-cache/);
  });

  it('says plainly when what is left is not a cache', () => {
    const ctx = context(failOn('project'));
    const outcomes = execute(
      boxItems(ctx).filter((i) => i.id.startsWith('box:key') || i.id === 'box:state'),
      'remove-everything',
      ctx.recordFile
    );
    const stateOutcome = outcomes.find((o) => o.item.id === 'box:state');
    expect(stateOutcome?.why).toContain('may hold sealed bundles or keys');
    expect(existsSync(join(state, 'go-cache'))).toBe(false);
    expect(existsSync(join(state, 'key-agent'))).toBe(false);
  });

  it('removes caches last, after every other entry', () => {
    const order: string[] = [];
    const left = clearStateEntries(state, false, (path) => {
      order.push(path.slice(state.length + 1));
      removeTree(path);
    });
    expect(left).toEqual([]);
    expect(order.at(-1)).toBe('go-cache');
    expect(order).not.toContain('created-resources.json');
  });

  it('keeps the key file when asked and still removes the rest of key-agent', () => {
    const left = clearStateEntries(state, true);
    expect(left).toEqual([]);
    expect(readdirSync(join(state, 'key-agent'))).toEqual(['kek']);
  });
});
