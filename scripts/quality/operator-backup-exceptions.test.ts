import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { scanText } from './check-no-secret-readback';

const CASES = [
  ['scripts/selfhost/backup-encryption.ts', 'transformFile'],
  ['scripts/selfhost/backup-lib.ts', 'runRestore'],
  ['scripts/selfhost/backup-recovery.ts', 'runRollback'],
] as const;
const scan = (file: string, text: string) => scanText(file, text, () => false).findings;

/** Delete the real first guard, so this control proves a missing failfast becomes a finding. */
function removeGuard(text: string, name: string): string {
  const source = ts.createSourceFile('operator.ts', text, ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === name
  ) as ts.FunctionDeclaration;
  const guard = fn.body!.statements[0];
  expect(guard.getText(source)).toBe('assertOperatorExecution();');
  return text.slice(0, guard.getStart(source)) + text.slice(guard.end);
}

describe('L24 operator-only backup scanner exception (policy 795e72a6)', () => {
  it.each(CASES)(
    'permits only the approved shape in %s and makes guard deletion red',
    (file, fn) => {
      const text = readFileSync(resolve(file), 'utf8');
      expect(scan(file, text)).toEqual([]);
      expect(scan(file, removeGuard(text, fn)).some((f) => f.rule === 'decryption')).toBe(true);
      expect(
        scan(`scripts/ci/${file.split('/').at(-1)}`, text).some((f) => f.rule === 'decryption')
      ).toBe(true);
    }
  );

  it.each(CASES)('still flags unrelated decryption, Pulumi reads and tracing in %s', (file) => {
    const text = readFileSync(resolve(file), 'utf8');
    const additions = [
      'crypto.subtle.decrypt(params, key, data);',
      "const extra = createDecipheriv('aes-256-gcm', otherKey, nonce);",
      "import { decryptToken } from './other-credentials';",
      'pulumi stack output --show-secrets',
      'set -x',
    ];
    for (const addition of additions) expect(scan(file, `${text}\n${addition}\n`)).toHaveLength(1);
    expect(scan(file.replace('.ts', '.sh'), 'printenv\n')).toMatchObject([{ rule: 'env-dump' }]);
  });

  it('pins envelope decryption to transformFile, AES-GCM arguments and one exact line', () => {
    const file = CASES[0][0];
    const text = readFileSync(resolve(file), 'utf8');
    for (const changed of [
      text.replace('function transformFile(', 'function unrelated('),
      text.replace(
        "? createDecipheriv('aes-256-gcm', key, nonce)",
        "? createDecipheriv('aes-256-gcm', otherKey, nonce)"
      ),
      text.replace(
        "? createDecipheriv('aes-256-gcm', key, nonce)",
        "? createDecipheriv('aes-256-gcm', key, nonce); crypto.subtle.decrypt(p, k, d)"
      ),
    ])
      expect(scan(file, changed).some((f) => f.rule === 'decryption')).toBe(true);
  });

  it.each(CASES.slice(1))(
    'refuses imported helper use outside its exact guarded function in %s',
    (file, fn) => {
      const text = readFileSync(resolve(file), 'utf8');
      const attached = text.replace(
        /(from ['"]\.\/backup-encryption(?:\.js)?['"];)/,
        '$1 crypto.subtle.decrypt(params, key, data);'
      );
      expect(scan(file, attached).some((f) => f.rule === 'decryption')).toBe(true);

      expect(
        scan(file, text.replace(`function ${fn}(`, 'function differentFunction(')).some(
          (f) => f.rule === 'decryption'
        )
      ).toBe(true);
      expect(
        scan(file, `${text}\nfunction other() { decryptBackupTree(from, dest, key); }`).some(
          (f) => f.rule === 'decryption'
        )
      ).toBe(true);
    }
  );
});
