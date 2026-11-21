import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FENCE_RULES_FILE,
  FENCE_RULES_MODE,
  repairFenceRulesMode,
  writeFenceFiles,
} from './fence-state.js';

let stateDir: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  stateDir = mkdtempSync(resolve('.tmp/fence-checkpoint-'));
  writeFileSync(join(stateDir, 'egress-fence.nft'), 'old rules');
  writeFileSync(join(stateDir, 'celld.env'), 'old env');
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));
const settings = {
  box: { GCE_METADATA_PROXY: 'off' },
  leaseRange: { start: 20000, end: 29999 },
  resolvConf: 'nameserver 127.0.0.53\n',
};

describe('fence input checkpoint ordering', () => {
  it('announces every changed input while both original files remain intact', async () => {
    let checkpointed: string[] | undefined;
    const result = await writeFenceFiles({
      stateDir,
      ...settings,
      beforeWrite(changed) {
        expect(readFileSync(join(stateDir, 'egress-fence.nft'), 'utf8')).toBe('old rules');
        expect(readFileSync(join(stateDir, 'celld.env'), 'utf8')).toBe('old env');
        checkpointed = [...changed];
      },
    });
    expect(checkpointed).toEqual([join(stateDir, 'egress-fence.nft'), join(stateDir, 'celld.env')]);
    expect(result.changed).toEqual(checkpointed);
  });

  it('leaves both live inputs untouched when the durable checkpoint fails', async () => {
    await expect(
      writeFenceFiles({
        stateDir,
        ...settings,
        beforeWrite() {
          throw new Error('checkpoint unavailable');
        },
      })
    ).rejects.toThrow('checkpoint unavailable');
    expect(readFileSync(join(stateDir, 'egress-fence.nft'), 'utf8')).toBe('old rules');
    expect(readFileSync(join(stateDir, 'celld.env'), 'utf8')).toBe('old env');
  });
});

describe('fence rules mode', () => {
  it('deploy --init repairs a restored 0600 rules file even when its content is unchanged', async () => {
    await writeFenceFiles({ stateDir, ...settings });
    const rules = join(stateDir, FENCE_RULES_FILE);
    const before = readFileSync(rules, 'utf8');
    // What a snapshot restore leaves behind (backup-encryption keeps only the exec bit).
    chmodSync(rules, 0o600);
    const result = await writeFenceFiles({ stateDir, ...settings });
    expect(result.changed).toEqual([]);
    expect(readFileSync(rules, 'utf8')).toBe(before);
    expect(statSync(rules).mode & 0o777).toBe(FENCE_RULES_MODE);
    // Control: the secret-bearing env file stays private.
    expect(statSync(join(stateDir, 'celld.env')).mode & 0o777).toBe(0o600);
  });

  it('refuses to change the mode through a symlink', () => {
    const target = join(stateDir, 'elsewhere');
    writeFileSync(target, 'x', { mode: 0o600 });
    rmSync(join(stateDir, FENCE_RULES_FILE));
    symlinkSync(target, join(stateDir, FENCE_RULES_FILE));
    expect(() => repairFenceRulesMode(stateDir)).toThrow(/not a regular file/);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('is a no-op without a rules file', () => {
    rmSync(join(stateDir, FENCE_RULES_FILE));
    expect(repairFenceRulesMode(stateDir)).toBe(false);
  });
});
