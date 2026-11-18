import { randomBytes } from 'node:crypto';

const SETUP_TOKEN_BYTES = 24;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Generates the first-run setup token for the API Worker's `SETUP_TOKEN` var.
 *
 * The token stays a plain-text var on purpose: first-run admins, and the lockout-recovery path,
 * read it from the Cloudflare dashboard. But `wrangler deploy` prints the value of every
 * plain-text binding, and the deploy job echoes that output into the public GitHub Actions log.
 * Inside GitHub Actions the token is therefore registered as a log mask before it is returned,
 * so every later step of the job prints `***` instead. Outside Actions nothing is printed: the
 * mask command would itself write the token to the console.
 */
export function generateSetupToken(
  env: Environment = process.env,
  write: (line: string) => void = (line) => process.stdout.write(line)
): string {
  const token = randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
  if (env.GITHUB_ACTIONS === 'true') write(`::add-mask::${token}\n`);
  return token;
}
