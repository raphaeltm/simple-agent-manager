/** Actual sidecar loop with nft at its process boundary and a forced publication race. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('converges to lost when the kernel observer latches between the publication check and mv', async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/fence-publication-'));
  const attestation = join(dir, 'attestation');
  const rules = join(dir, 'rules.nft');
  const raced = join(dir, 'raced');
  writeFileSync(rules, 'table inet sam_celld_egress {}\n');
  writeFileSync(
    join(dir, 'nft'),
    '#!/bin/sh\nif [ "$1" = monitor ]; then exec sleep 300; fi\nif [ "$1" = -s ]; then echo "table inet sam_celld_egress {}"; fi\n',
    { mode: 0o755 }
  );
  // Force the precise real writer ordering: latch+lost, then the already-admitted mv publishes ok.
  writeFileSync(
    join(dir, 'mv'),
    `#!/bin/sh
if [ ! -f "$SAM_TEST_RACED" ]; then
  echo lost > "$SAM_TEST_LOST"
  echo lost > "$SAM_TEST_ATTESTATION"
  touch "$SAM_TEST_RACED"
fi
exec /bin/mv "$@"
`,
    { mode: 0o755 }
  );
  const child = spawn(
    '/bin/sh',
    [resolve(import.meta.dirname, '../../deploy/selfhost/egress-fence/fence.sh')],
    {
      detached: true,
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        SAM_EGRESS_FENCE_RULES: rules,
        SAM_EGRESS_FENCE_STATE: join(dir, 'applied'),
        SAM_EGRESS_FENCE_ATTESTATION: attestation,
        SAM_EGRESS_FENCE_RECHECK_SECONDS: '0.01',
        SAM_TEST_RACED: raced,
        SAM_TEST_LOST: join(dir, 'lost'),
        SAM_TEST_ATTESTATION: attestation,
      },
      stdio: 'ignore',
    }
  );
  try {
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      (!existsSync(raced) ||
        !existsSync(attestation) ||
        readFileSync(attestation, 'utf8') !== 'lost\n')
    )
      await new Promise((done) => setTimeout(done, 20));
    expect(existsSync(raced)).toBe(true);
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toContain('egress_fence.verified');
    expect(readFileSync(attestation, 'utf8')).toBe('lost\n');
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    await new Promise<void>((done) =>
      child.exitCode !== null || child.signalCode !== null
        ? done()
        : child.once('exit', () => done())
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
