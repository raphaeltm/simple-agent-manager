import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const lintText = async (code: string, filePath: string) => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, filePath),
  });
  return result.messages;
};

describe('ESLint 8 to ESLint 9 flat-config parity', () => {
  it('uses the supported ESLint 9 host', () => {
    expect(ESLint.version).toMatch(/^9\./);
  });

  it('preserves the audited v7 type-only-use behavior', async () => {
    const messages = await lintText(
      `
        function makeFixture() {
          return { id: 'fixture' };
        }
        export type Fixture = ReturnType<typeof makeFixture>;
      `,
      'apps/web/src/eslint-parity.ts'
    );

    expect(
      messages.filter((message) => message.ruleId === '@typescript-eslint/no-unused-vars')
    ).toEqual([]);
  });

  it('continues to reject genuinely unused runtime values', async () => {
    const messages = await lintText(
      'const unusedRuntimeValue = 1; export {};',
      'apps/web/src/eslint-parity.ts'
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: '@typescript-eslint/no-unused-vars',
          severity: 2,
        }),
      ])
    );
  });

  it('retains legacy jsx-a11y options when lowering severity', async () => {
    const messages = await lintText(
      `
        export function ParityFixture() {
          return (
            <>
              <div onBlur={() => undefined}>blur is not a legacy handler</div>
              <div onClick={() => undefined}>click is a legacy handler</div>
            </>
          );
        }
      `,
      'apps/web/src/eslint-parity.tsx'
    );
    const staticInteractionMessages = messages.filter(
      (message) => message.ruleId === 'jsx-a11y/no-static-element-interactions'
    );

    expect(staticInteractionMessages).toHaveLength(1);
    expect(staticInteractionMessages[0]).toMatchObject({
      line: 6,
      severity: 1,
    });
  });
});
