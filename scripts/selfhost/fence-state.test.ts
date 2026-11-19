import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFenceFiles } from './fence-state.js';

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
