/** One executable recovery command for the current, populated, owned installation. */
import type { BoxContext } from './upgrade-lib.js';

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function rollbackSteps(
  ctx: Pick<BoxContext, 'envFile' | 'stateDir' | 'secretsFile' | 'encryptionKeyFile'>,
  from: string,
  backupDir: string,
  imagesRebuilt: readonly string[]
): string[] {
  return [
    [
      'pnpm',
      'selfhost:upgrade',
      '--to',
      from,
      '--rollback-from',
      backupDir,
      '--box-env',
      ctx.envFile,
      '--state-dir',
      ctx.stateDir,
      ...(ctx.secretsFile ? ['--secrets', ctx.secretsFile] : []),
      ...(ctx.encryptionKeyFile ? ['--encryption-key-file', ctx.encryptionKeyFile] : []),
      ...imagesRebuilt.flatMap((service) => ['--rebuild', service]),
    ]
      .map(shellWord)
      .join(' '),
  ];
}
