import { execFileSync } from 'node:child_process';

interface ReadDependencies {
  execute: (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      encoding: 'utf8';
      stdio: ['ignore', 'pipe', 'pipe'];
    }
  ) => string;
  sleep: (milliseconds: number) => void;
  warn: (message: string) => void;
  env: Record<string, string | undefined>;
}

function boundedInteger(
  env: ReadDependencies['env'],
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected an integer from ${min} through ${max}`);
  }
  return value;
}

function resourceLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  for (const stream of ['stdout', 'stderr'] as const) {
    const output = (error as Record<string, unknown>)[stream];
    const text = Buffer.isBuffer(output) ? output.toString('utf8') : output;
    if (typeof text !== 'string') continue;
    try {
      // Inspect only the structured provider code; messages may contain SQL or identifiers.
      if (JSON.parse(text)?.error?.code === 7429) return true;
    } catch {
      // Unknown/malformed failures remain non-retryable.
    }
  }
  return false;
}

/** Only for verification reads. Migration/repair writes use the separate execute path. */
export function executeD1VerificationRead(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
  dependencies: Partial<ReadDependencies> = {}
): string {
  const env = dependencies.env ?? process.env;
  const attempts = boundedInteger(env, 'D1_MIGRATION_READ_ATTEMPTS', 3, 1, 5);
  // The provider's resource accounting window is ten seconds; allow it to clear.
  const delay = boundedInteger(env, 'D1_MIGRATION_READ_RETRY_DELAY_MS', 10_000, 0, 60_000);
  const execute: ReadDependencies['execute'] =
    dependencies.execute ?? ((cmd, argv, opts) => execFileSync(cmd, argv, opts));
  const sleep =
    dependencies.sleep ??
    ((ms: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    });
  const warn = dependencies.warn ?? console.warn;
  for (let attempt = 1; ; attempt++) {
    try {
      return execute(command, args, {
        ...options,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const category = resourceLimited(error) ? 'resource_limit' : 'unknown';
      if (category === 'unknown' || attempt >= attempts) {
        throw new Error(`D1 verification read failed (category=${category}, attempts=${attempt})`, {
          cause: error,
        });
      }
      warn(
        `D1 verification read retry (category=${category}, attempt=${attempt}/${attempts}, delayMs=${delay})`
      );
      sleep(delay);
    }
  }
}
