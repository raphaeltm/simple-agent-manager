// Keeps branches that add a Durable Object migration off the primary staging installation.
// Durable Object migrations only move forward: once a branch deploys tag vN+1 to an
// installation, every main-based branch (history ending at vN) fails the migration preflight
// there (scripts/deploy/durable-object-migrations.ts) until that branch merges. Such branches
// verify on staging2, whose holder rebuilds it from main before releasing (staging reference,
// "Branches that add a Durable Object migration").
//
//   node scripts/deploy/staging-migration-guard.mjs   # deploy-staging.yml job `queue`
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WRANGLER_TOML = 'apps/api/wrangler.toml';
export const PRIMARY_INSTALLATION = 'staging';
// An absolute path on the runner, so PATH cannot substitute another binary.
const GIT = process.env.GITHUB_ACTIONS === 'true' ? '/usr/bin/git' : 'git';

// Tags in [[migrations]] order. Fails closed on anything it cannot read unambiguously.
export function migrationTags(toml, source) {
  if (typeof toml !== 'string' || toml.length === 0)
    throw new Error(`${source}: empty wrangler.toml`);
  const blocks = toml.match(/^\[\[migrations\]\][ \t]*$/gm)?.length ?? 0;
  const tags = [
    ...toml.matchAll(/^\[\[migrations\]\][ \t]*\r?\n[ \t]*tag[ \t]*=[ \t]*"([^"\n]+)"/gm),
  ].map((match) => match[1]);
  if (blocks === 0 || tags.length !== blocks)
    throw new Error(
      `${source}: cannot read every [[migrations]] tag (${tags.length} of ${blocks})`
    );
  return tags;
}

export function newMigrationTags(branchToml, mainToml) {
  const main = new Set(migrationTags(mainToml, 'origin/main'));
  return migrationTags(branchToml, 'branch').filter((tag) => !main.has(tag));
}

// Returns null when the deploy may proceed, or the refusal message.
export function checkInstallation({ installation, action, branchToml, mainToml }) {
  if (installation !== PRIMARY_INSTALLATION || action !== 'deploy') return null;
  const added = newMigrationTags(branchToml, mainToml);
  if (added.length === 0) return null;
  return `This branch adds Durable Object migration tag(s) ${added.join(', ')} that origin/main does not have. Deploying it to primary staging would block every main-based branch there until it merges (migrations only move forward). Use -f environment=staging2; if the branch has not merged when you are done, tear staging2 down and redeploy main before releasing.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const installation = process.env.LEASE_ENVIRONMENT || PRIMARY_INSTALLATION;
    const action = process.env.LEASE_ACTION || 'deploy';
    let refusal = null;
    if (installation === PRIMARY_INSTALLATION && action === 'deploy') {
      execFileSync(GIT, ['fetch', '--quiet', '--depth=1', 'origin', 'main'], {
        stdio: 'inherit',
      });
      refusal = checkInstallation({
        installation,
        action,
        branchToml: readFileSync(WRANGLER_TOML, 'utf8'),
        mainToml: execFileSync(GIT, ['show', `FETCH_HEAD:${WRANGLER_TOML}`], {
          encoding: 'utf8',
        }),
      });
    }
    if (refusal) throw new Error(refusal);
    console.log('Durable Object migration guard: no new migration tags for primary staging.');
  } catch (error) {
    console.error(`Staging deploy refused: ${error.message}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
