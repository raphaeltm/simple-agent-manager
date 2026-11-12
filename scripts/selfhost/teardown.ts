/**
 * `pnpm selfhost:teardown`: removes what a self-hosted install created or helped create.
 *
 *   pnpm selfhost:teardown                                  inventory (read only, the default)
 *   pnpm selfhost:teardown --keep-data [--dry-run] --confirm <domain>
 *       stop, delete node VMs and the bootstrap's cloud identity; keep bucket, backups, key file,
 *       bundles, .env and state, so `docker compose up -d` and the bootstrap bring it back
 *   pnpm selfhost:teardown --remove-everything [--dry-run] --confirm <domain>
 *       also the bucket contents, compose volumes and images, .state and .env
 *     --delete-backups   also delete local backups (never without this flag)
 *     --destroy-key      also delete the key file / schedule the cloud KMS key's destruction
 *   --gcp-project <id>   a Google Cloud project nodes ran in (default: the bootstrap's, recorded)
 *   --adopt-discovered   remove bootstrap resources found by name on an install from before the record
 *   --box-env <file>, --state-dir <dir>   as for the other selfhost commands
 *
 * What may be removed comes from `.state/created-resources.json` (install-record.ts and the
 * bootstraps write it at creation time) or from the exact names and labels the install sets, shown
 * as "discovered, not recorded". Order and bookkeeping: teardown-model.ts. Items: teardown-box.ts
 * (box, bucket, outside) and teardown-gcp.ts (Google Cloud). Re-running continues after a failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { normalizeInstallationId } from '../../apps/api/src/services/node-provider-labels';
import { type CreatedResource, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { log, runCommand, SELFHOST_DIR } from './backup-cli';
import { recordPath } from './install-record';
import { assertPrivateFile, parseDotenv } from './secret-files';
import { boxItems, bucketItems, type TeardownContext } from './teardown-box';
import { gcpItems } from './teardown-gcp';
import {
  execute,
  type Item,
  type Mode,
  renderInventory,
  renderPlan,
  renderSummary,
} from './teardown-model';
import { outsideItems } from './teardown-outside';

function parse() {
  const { values } = parseArgs({
    options: {
      'keep-data': { type: 'boolean', default: false },
      'remove-everything': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      confirm: { type: 'string' },
      'delete-backups': { type: 'boolean', default: false },
      'destroy-key': { type: 'boolean', default: false },
      'adopt-discovered': { type: 'boolean', default: false },
      'gcp-project': { type: 'string', multiple: true },
      'box-env': { type: 'string' },
      'state-dir': { type: 'string' },
    },
  });
  if (values['keep-data'] && values['remove-everything']) {
    throw new Error('choose one of --keep-data and --remove-everything');
  }
  const mode: Mode | undefined = values['keep-data']
    ? 'keep-data'
    : values['remove-everything']
      ? 'remove-everything'
      : undefined;
  if ((values['delete-backups'] || values['destroy-key']) && mode !== 'remove-everything') {
    throw new Error('--delete-backups and --destroy-key go with --remove-everything only');
  }
  return { values, mode };
}

function installationFromLegacyKeys(stateDir: string): string | null {
  try {
    const keys = JSON.parse(readFileSync(join(stateDir, 'platform-keys.json'), 'utf8')) as unknown;
    const id = (keys as { SAM_INSTALLATION_ID?: unknown }).SAM_INSTALLATION_ID;
    return typeof id === 'string' ? normalizeInstallationId(id) : null;
  } catch {
    return null;
  }
}

/**
 * The installation id that proves node VM ownership. Only an unambiguous one counts (security
 * review M2): exactly one recorded id, for this .env's domain, agreeing with platform-keys.json
 * when that file exists. Anything else leaves the id unknown, so every VM is refused.
 */
function resolveInstallation(
  record: CreatedResource[],
  domain: string | undefined,
  legacyId: string | null
): { entry?: CreatedResource; recordedId: string | null; id: string | null; problem?: string } {
  const entries = record.filter((r) => r.cloud === 'box' && r.kind === 'installation');
  const ids = [...new Set(entries.map((r) => normalizeInstallationId(r.name)))];
  const entry = entries.at(-1);
  if (entries.length === 0) return { recordedId: null, id: legacyId };
  if (ids.length !== 1 || !ids[0]) {
    return {
      entry,
      recordedId: null,
      id: null,
      problem: `the record names ${ids.length} installation ids`,
    };
  }
  const id = ids[0];
  if (domain && entries.some((r) => r.attributes?.domain !== domain)) {
    return {
      entry,
      recordedId: null,
      id: null,
      problem: `the record is for another domain than ${domain}`,
    };
  }
  if (legacyId && legacyId !== id) {
    return {
      entry,
      recordedId: null,
      id: null,
      problem: 'platform-keys.json names another installation id',
    };
  }
  return { entry, recordedId: id, id };
}

async function confirm(expected: string, given: string | undefined): Promise<boolean> {
  if (given !== undefined) return given === expected;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await rl.question(`Type the install's name (${expected}) to continue: `)).trim() === expected
    );
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const { values, mode } = parse();
  const envFile = resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env'));
  let box: Record<string, string> = {};
  if (existsSync(envFile)) {
    assertPrivateFile(envFile);
    box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  }
  const stateDir = resolve(
    dirname(envFile),
    values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
  );
  const recordFile = recordPath(stateDir);
  const record = readRecord(recordFile).resources;
  if (!existsSync(envFile) && record.length === 0) {
    throw new Error(`neither ${envFile} nor ${recordFile} exists: nothing to inventory`);
  }
  const resolved = resolveInstallation(
    record,
    box.SAM_DOMAIN,
    installationFromLegacyKeys(stateDir)
  );
  const install = resolved.entry;
  const recordedId = resolved.recordedId;
  const installationId = resolved.id;
  const domain = box.SAM_DOMAIN ?? install?.attributes?.domain ?? '';
  if (resolved.problem) log(`node VMs will not be touched: ${resolved.problem}`);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const ctx: TeardownContext = {
    box,
    envFile,
    stateDir,
    composeFile: join(SELFHOST_DIR, 'docker-compose.yml'),
    run: runCommand,
    now: () => Date.now(),
    log,
    user: uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined,
    mode,
    options: {
      deleteBackups: values['delete-backups'] ?? false,
      destroyKey: values['destroy-key'] ?? false,
      adoptDiscovered: values['adopt-discovered'] ?? false,
      gcpProjects: values['gcp-project'] ?? [],
    },
    record,
    recordFile,
    domain,
    installationId,
    selfhostDir: SELFHOST_DIR,
  };
  const idSource = recordedId
    ? 'recorded'
    : installationId
      ? 'discovered, not recorded: platform-keys.json'
      : 'unknown';
  log(
    `install ${domain || '(domain unknown)'}, installation ${installationId ?? '?'} (${idSource})`
  );
  log(`record ${recordFile}${existsSync(recordFile) ? '' : ' (none yet)'}`);
  const items: Item[] = [
    ...boxItems(ctx),
    ...bucketItems(ctx),
    ...gcpItems(ctx),
    ...outsideItems(ctx),
  ];

  if (!mode) {
    process.stdout.write(
      `${renderInventory(items)}\n\nRead only: nothing was changed. Remove with --keep-data or --remove-everything (add --dry-run first).\n`
    );
    return 0;
  }
  process.stdout.write(
    `\nPlan (${mode === 'keep-data' ? 'keep my data' : 'remove everything'}):\n${renderPlan(items, mode)}\n`
  );
  if (values['dry-run']) {
    process.stdout.write('\nDry run: nothing was changed.\n');
    return 0;
  }
  const name = domain || installationId;
  if (!name)
    throw new Error(
      'cannot name this install (no SAM_DOMAIN, no record): refusing to remove anything'
    );
  if (!(await confirm(name, values.confirm))) {
    throw new Error(
      `confirmation did not match: pass --confirm ${name} to remove what the plan lists`
    );
  }
  const outcomes = execute(items, mode, recordFile);
  process.stdout.write(`${renderSummary(outcomes)}\n`);
  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
