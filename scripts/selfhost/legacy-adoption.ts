/**
 * `pnpm selfhost:upgrade --adopt-legacy --from <deployed sha> --to <ref>`: moves a pre-L24
 * install off the shared `sam-selfhost` Compose project into its canonical installation-specific
 * project, then upgrades it with the normal L24 path (upgrade-lib.ts:runUpgrade).
 *
 * Adoption changes no SAM code and deploys nothing: it proves ownership, takes the encrypted
 * snapshot, stops the legacy stack, copies its volumes, writes COMPOSE_PROJECT_NAME, starts the
 * same deployed version under the new name, verifies health and writes the creation receipts.
 * Any failure before verified health rolls back to the legacy project (its volumes are only
 * read, unless the canonical stack ran: then its newer copies are carried back first). Every
 * step is journaled (legacy-adoption-journal.ts), so a killed run resumes where it stopped.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { check, composeArgs, composeRunEnv, runBackup } from './backup-lib';
import { REPO_ROOT } from './deploy-steps';
import { expectedComposeProjectFor, readInstallRecord, recordInstall } from './install-record';
import {
  containersLabelled,
  LEGACY_COMPOSE_PROJECT,
  proveLegacyOwnership,
} from './legacy-adoption-inventory';
import {
  ADOPTION_ENV_FILE,
  type AdoptionJournal,
  clearAdoptionJournal,
  envWithProject,
  phaseAtLeast,
  readAdoptionJournal,
  readOriginalEnv,
  saveOriginalEnv,
  writeAdoptionJournal,
} from './legacy-adoption-journal';
import {
  copyVolume,
  createCanonicalVolume,
  DEFAULT_ADOPTION_HELPER_IMAGE,
  ensureHelperImage,
  type Helper,
  helperName,
  helperNames,
  ownedCanonicalVolume,
  removeStaleHelper,
  removeVolume,
  returnHelperName,
} from './legacy-adoption-volumes';
import { checkoutWithTrackedModes } from './operator-files';
import { assertOperatorExecution } from './operator-only';
import { readPrivateJson, replacePrivateFile } from './secret-files';
import { readPendingFrom, UPGRADE_PENDING_FILE, upgradeCompletedTo } from './upgrade-journal';
import type { BoxContext, UpgradeOptions } from './upgrade-lib';

export interface AdoptionOptions {
  /** The target ref; the operator has already checked it out (its tool runs this adoption). */
  to: string;
  /** Full SHA of the SAM commit the legacy stack is running (checked against its config hashes). */
  from: string;
  checkHealth: () => Promise<boolean>;
  /** The adoption snapshot; default `backups/pre-adoption-<timestamp>` beside the state dir. */
  backupDir?: string;
  /** Passed to the upgrade that follows adoption (its own fresh snapshot). */
  upgradeBackupDir?: string;
  /** The encrypted snapshot (backup-lib.ts runBackup); replaceable only in tests. */
  backup?: typeof runBackup;
  /** The upgrade that follows a verified adoption: upgrade-lib.ts runUpgrade. */
  upgrade: (ctx: BoxContext, opts: UpgradeOptions) => Promise<unknown>;
  legacyProject?: string;
  helperImage?: string;
  checkoutRoot?: string;
}

const SHA = /^[a-f0-9]{40}$/;

const helperOf = (opts: AdoptionOptions, journal: AdoptionJournal): Helper => ({
  image: opts.helperImage ?? DEFAULT_ADOPTION_HELPER_IMAGE,
  adoptionId: journal.adoptionId,
});

function backupCtx(ctx: BoxContext) {
  return {
    ...ctx,
    now: () => Date.now(),
    user: process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined,
  };
}

const withProject = (ctx: BoxContext, project: string): BoxContext => ({
  ...ctx,
  box: { ...ctx.box, COMPOSE_PROJECT_NAME: project },
});

function compose(ctx: BoxContext, args: string[], what: string): string {
  return check(ctx.run('docker', composeArgs(ctx, args), composeRunEnv(ctx)), what).stdout;
}

/** Every `checkout --detach` re-applies git's file modes (operator-files.ts). */
function git(ctx: BoxContext, args: string[], what: string): string {
  const [command, flag, ref] = args;
  const detach = command === 'checkout' && flag === '--detach' && ref && args.length === 3;
  const result = detach ? checkoutWithTrackedModes(ctx.run, ref, ctx.log) : ctx.run('git', args);
  return check(result, what).stdout.trim();
}

function installationIdOf(stateDir: string): string {
  const keys = join(stateDir, 'platform-keys.json');
  if (!existsSync(keys))
    throw new Error('Legacy adoption refused: no platform-keys.json; run deploy --init first');
  const id = readPrivateJson(keys).SAM_INSTALLATION_ID ?? '';
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new Error('Legacy adoption refused: cannot read SAM_INSTALLATION_ID');
  return id;
}

function hasComposeReceipt(stateDir: string, project: string): boolean {
  return readInstallRecord(stateDir).some(
    (r) =>
      r.cloud === 'box' &&
      r.kind === 'compose-project' &&
      r.name === project &&
      r.action === 'created' &&
      !r.removedAt
  );
}

/** A new adoption: the install must be a legacy one this tool has not adopted yet. */
function startJournal(ctx: BoxContext, opts: AdoptionOptions, to: string): AdoptionJournal {
  const legacyProject = opts.legacyProject ?? LEGACY_COMPOSE_PROJECT;
  const named = ctx.box.COMPOSE_PROJECT_NAME;
  if (named !== undefined && named !== legacyProject)
    throw new Error(
      `Legacy adoption refused: COMPOSE_PROJECT_NAME is ${named}, not the legacy ${legacyProject}; use a normal upgrade`
    );
  if (existsSync(join(ctx.stateDir, UPGRADE_PENDING_FILE)))
    throw new Error(
      'Legacy adoption refused: an unfinished upgrade record exists; inspect it before adopting'
    );
  const envCopy = join(ctx.stateDir, ADOPTION_ENV_FILE);
  // A completed run removes its journal first, so a kill can leave only the copy behind. When it
  // is byte-identical to .env it records nothing that is not already there.
  if (existsSync(envCopy) && readOriginalEnv(ctx.stateDir) === readFileSync(ctx.envFile, 'utf8'))
    rmSync(envCopy);
  if (existsSync(envCopy))
    throw new Error(
      `Legacy adoption refused: ${ctx.stateDir}/${ADOPTION_ENV_FILE} exists without its journal; inspect it (it is a copy of an earlier .env) and remove it`
    );
  const installationId = installationIdOf(ctx.stateDir);
  const box = { ...ctx.box };
  delete box.COMPOSE_PROJECT_NAME;
  const canonicalProject = expectedComposeProjectFor(box, ctx.stateDir, installationId);
  if (canonicalProject === legacyProject)
    throw new Error('Legacy adoption refused: canonical and legacy projects coincide');
  if (hasComposeReceipt(ctx.stateDir, canonicalProject))
    throw new Error(
      'Legacy adoption refused: this install already has its compose creation receipt; use a normal upgrade'
    );
  return {
    version: 1,
    adoptionId: randomBytes(16).toString('hex'),
    from: opts.from,
    to,
    legacyProject,
    canonicalProject,
    installationId,
    phase: 'proving',
    legacyContainers: [],
    volumes: [],
    canonicalStarted: false,
  };
}

/** The canonical project must be empty, apart from volumes this journal created. */
function assertCanonicalClear(ctx: BoxContext, journal: AdoptionJournal): void {
  const label = `com.docker.compose.project=${journal.canonicalProject}`;
  if (!journal.canonicalStarted && containersLabelled(ctx, label).length > 0)
    throw new Error(
      `Legacy adoption refused: compose project ${journal.canonicalProject} already has containers`
    );
  const listed = check(
    ctx.run('docker', ['volume', 'ls', '--quiet', '--filter', `label=${label}`]),
    'list canonical volumes'
  )
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of listed) {
    const owned = journal.volumes.find((v) => v.canonical === name);
    if (!owned)
      throw new Error(`Legacy adoption refused: ${name} exists and is not this adoption's copy`);
    // Labelled with this journal's random adoption id; a kill can precede recording its CreatedAt.
    const volume = ownedCanonicalVolume(
      ctx,
      journal.canonicalProject,
      owned.suffix,
      journal.adoptionId,
      owned.createdAt
    );
    if (volume && !owned.createdAt) owned.createdAt = volume.createdAt;
  }
  // A label filter misses an unlabelled volume at a canonical name: inspect every expected name,
  // so a collision refuses before the backup and the stop instead of stranding the rollback.
  for (const volume of journal.volumes) {
    const present = ownedCanonicalVolume(
      ctx,
      journal.canonicalProject,
      volume.suffix,
      journal.adoptionId,
      volume.createdAt
    );
    if (present && !volume.createdAt) volume.createdAt = present.createdAt;
  }
}

async function adopt(ctx: BoxContext, opts: AdoptionOptions, journal: AdoptionJournal) {
  const save = () => writeAdoptionJournal(ctx.stateDir, journal);
  const legacy = withProject(ctx, journal.legacyProject);
  const canonical = withProject(ctx, journal.canonicalProject);
  const helper = helperOf(opts, journal);
  // A killed run can leave a copy or digest helper mounting the volumes: remove ours first.
  for (const name of helperNames(
    journal.canonicalProject,
    journal.volumes.map((v) => v.suffix)
  ))
    removeStaleHelper(ctx, helper, name);
  const stopped = phaseAtLeast(journal, 'stopped') || journal.stopRequested === true;
  // A kill inside the backup can leave the legacy celld stopped for its delta copy.
  if (!stopped && journal.backupStarted && !phaseAtLeast(journal, 'backed-up'))
    restartLegacyCelld(ctx, journal);
  const inventory = proveLegacyOwnership(legacy, {
    legacyProject: journal.legacyProject,
    checkoutRoot: opts.checkoutRoot ?? REPO_ROOT,
    configHashOutput: compose(legacy, ['config', '--hash', '*'], 'read legacy config hashes'),
    requireRunningCelld: !stopped,
  });
  if (journal.volumes.length === 0) {
    journal.legacyContainers = inventory.containers.map((c) => c.id);
    journal.volumes = inventory.volumes.map((v) => ({
      suffix: v.suffix,
      legacy: v.name,
      canonical: `${journal.canonicalProject}_${v.suffix}`,
    }));
  } else if (
    JSON.stringify(inventory.volumes.map((v) => v.name).sort()) !==
      JSON.stringify(journal.volumes.map((v) => v.legacy).sort()) ||
    inventory.containers.some((c) => !journal.legacyContainers.includes(c.id))
  ) {
    throw new Error(
      'Legacy adoption refused: the legacy project changed since this adoption began'
    );
  }
  assertCanonicalClear(ctx, journal);
  save();

  ensureHelperImage(ctx, helper.image);

  if (!phaseAtLeast(journal, 'backed-up')) {
    // A run killed mid-backup leaves an unproven partial: it is kept, never reused.
    const fresh = join(
      dirname(ctx.stateDir),
      'backups',
      `pre-adoption-${new Date().toISOString().replace(/[:.]/g, '-')}`
    );
    const dest =
      journal.backupDir === undefined
        ? (opts.backupDir ?? fresh)
        : existsSync(journal.backupDir)
          ? fresh
          : journal.backupDir;
    journal.backupDir = resolve(dest);
    journal.backupStarted = true;
    save();
    (opts.backup ?? runBackup)(backupCtx(legacy), journal.backupDir, journal.from);
    journal.phase = 'backed-up';
    save();
  }

  try {
    if (!phaseAtLeast(journal, 'stopped')) {
      journal.stopRequested = true;
      save();
      compose(legacy, ['stop'], 'stop legacy stack');
      journal.phase = 'stopped';
      save();
    }
    if (!phaseAtLeast(journal, 'switched')) {
      for (const volume of journal.volumes) {
        if (volume.digest) continue;
        const existing = ownedCanonicalVolume(
          ctx,
          journal.canonicalProject,
          volume.suffix,
          journal.adoptionId,
          volume.createdAt
        );
        if (existing) volume.createdAt = existing.createdAt;
        else {
          volume.createdAt = createCanonicalVolume(
            ctx,
            journal.canonicalProject,
            volume.suffix,
            journal.adoptionId
          ).createdAt;
          save();
        }
        ctx.log(`copying ${volume.legacy} -> ${volume.canonical}`);
        volume.digest = copyVolume(
          ctx,
          helper,
          volume.legacy,
          volume.canonical,
          helperName(journal.canonicalProject, volume.suffix)
        );
        save();
      }
      saveOriginalEnv(ctx.stateDir, ctx.envFile);
      replacePrivateFile(
        ctx.envFile,
        envWithProject(readOriginalEnv(ctx.stateDir), journal.canonicalProject)
      );
      journal.phase = 'switched';
      save();
    }
    // Compose would silently recreate a missing volume empty: every copy must still be there.
    for (const volume of journal.volumes)
      if (
        !ownedCanonicalVolume(
          ctx,
          journal.canonicalProject,
          volume.suffix,
          journal.adoptionId,
          volume.createdAt
        )
      )
        throw new Error(`Legacy adoption: the copy ${volume.canonical} is missing`);
    journal.canonicalStarted = true;
    save();
    compose(canonical, ['up', '-d'], 'start canonical stack');
    if (!(await opts.checkHealth()))
      throw new Error('the adopted install is not healthy under its canonical compose project');
  } catch (error) {
    await rollbackToLegacy(ctx, opts, journal);
    throw error;
  }

  recordInstall(ctx.stateDir, ctx.envFile, canonical.box, journal.installationId);
  journal.phase = 'adopted';
  save();
  removeLegacyContainers(ctx, journal);
  ctx.log(`adopted: compose project ${journal.canonicalProject} is healthy with its receipts`);
}

/** `compose start celld` for the legacy project: a no-op when celld already runs. */
function restartLegacyCelld(ctx: BoxContext, journal: AdoptionJournal): void {
  compose(
    withProject(ctx, journal.legacyProject),
    ['start', 'celld'],
    'restart legacy celld after an interrupted backup'
  );
}

/** The stopped legacy containers, by their proved IDs only; volumes are kept. Idempotent. */
function removeLegacyContainers(ctx: BoxContext, journal: AdoptionJournal): void {
  const remaining = new Set(
    containersLabelled(ctx, `com.docker.compose.project=${journal.legacyProject}`)
  );
  const stale = journal.legacyContainers.filter((id) => remaining.has(id));
  if (stale.length) check(ctx.run('docker', ['rm', ...stale]), 'remove stopped legacy containers');
}

/** Rollback could not restore the legacy stack: its journal and env copy must be kept. */
class RollbackIncomplete extends Error {}

/**
 * Back to the legacy project. Before the canonical stack starts, the legacy volumes were only
 * read. Once it ran, its copies hold the newest state, so each is copied back over its legacy
 * volume (digest-verified) before the canonical volumes are removed.
 */
async function rollbackToLegacy(ctx: BoxContext, opts: AdoptionOptions, journal: AdoptionJournal) {
  ctx.log('legacy adoption failed; restoring the legacy compose project');
  journal.rollingBack = true;
  writeAdoptionJournal(ctx.stateDir, journal);
  const legacy = withProject(ctx, journal.legacyProject);
  const canonical = withProject(ctx, journal.canonicalProject);
  const helper = helperOf(opts, journal);
  try {
    for (const name of helperNames(
      journal.canonicalProject,
      journal.volumes.map((v) => v.suffix)
    ))
      removeStaleHelper(ctx, helper, name);
    if (journal.canonicalStarted)
      compose(canonical, ['down', '--remove-orphans'], 'stop canonical stack');
    const owned = journal.volumes.map((volume) => ({
      volume,
      present: ownedCanonicalVolume(
        ctx,
        journal.canonicalProject,
        volume.suffix,
        journal.adoptionId,
        volume.createdAt
      ),
    }));
    // Once the canonical stack ran, every one of its volumes holds the newest state (the celld
    // cache, renewed certificates, and with `local-store` the bucket itself): all of it goes back.
    if (journal.canonicalStarted)
      for (const { volume, present } of owned)
        if (present)
          copyVolume(
            ctx,
            helper,
            present.name,
            volume.legacy,
            returnHelperName(journal.canonicalProject, volume.suffix)
          );
    for (const { present } of owned) if (present) removeVolume(ctx, present.name);
    if (phaseAtLeast(journal, 'switched') || existsSync(join(ctx.stateDir, ADOPTION_ENV_FILE)))
      replacePrivateFile(ctx.envFile, readOriginalEnv(ctx.stateDir));
    compose(legacy, ['up', '-d'], 'restart legacy stack');
    if (!(await opts.checkHealth())) throw new Error('legacy stack is not healthy');
  } catch (rollbackError) {
    // check() never relays tool output, so these messages carry no secrets.
    ctx.log(
      `rollback step failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
    );
    throw new RollbackIncomplete(
      `legacy adoption failed and rollback did not complete; keep ${ctx.stateDir}/legacy-adoption.json, its legacy-adoption.env and the legacy volumes, then inspect the stack`
    );
  }
  clearAdoptionJournal(ctx.stateDir);
  ctx.log(
    `restored the legacy project ${journal.legacyProject} at ${journal.from.slice(0, 12)}; to retry, check out ${journal.to} and rerun the same command`
  );
}

export async function runLegacyAdoption(ctx: BoxContext, opts: AdoptionOptions): Promise<void> {
  assertOperatorExecution();
  if (!SHA.test(opts.from)) throw new Error('--from must be the full 40-character deployed commit');
  if (process.env.COMPOSE_PROJECT_NAME !== undefined)
    throw new Error('Unset COMPOSE_PROJECT_NAME in the shell before legacy adoption');
  if (git(ctx, ['status', '--porcelain', '--untracked-files=no'], 'git status') !== '')
    throw new Error(
      'the checkout has uncommitted changes to tracked files; commit or stash them first'
    );
  git(ctx, ['cat-file', '-e', `${opts.from}^{commit}`], `find --from ${opts.from}`);
  const head = git(ctx, ['rev-parse', 'HEAD'], 'git rev-parse HEAD');

  let journal = readAdoptionJournal(ctx.stateDir);
  if (journal) {
    if (journal.from !== opts.from)
      throw new Error(`an unfinished adoption started from ${journal.from}; pass the same --from`);
    if (
      head !== journal.to &&
      head !== journal.from &&
      !existsSync(join(ctx.stateDir, UPGRADE_PENDING_FILE))
    )
      throw new Error(`check out ${journal.to} (the adoption target) before resuming`);
    ctx.log(`resuming legacy adoption at phase ${journal.phase}`);
    if (journal.rollingBack) {
      // Finish the interrupted rollback; never resume forward from a half-removed copy.
      if (head !== journal.from)
        git(ctx, ['checkout', '--detach', journal.from], 'check out --from');
      await rollbackToLegacy(ctx, opts, journal);
      throw new Error(
        'legacy adoption was rolled back after an interrupted rollback; rerun to retry'
      );
    }
  } else {
    if (head === opts.from)
      throw new Error('check out the target SAM ref first; --from is the commit the stack runs');
    const target = git(ctx, ['rev-parse', '--verify', `${opts.to}^{commit}`], `resolve ${opts.to}`);
    if (target !== head)
      throw new Error(`check out ${opts.to} first: legacy adoption runs from the target checkout`);
    journal = startJournal(ctx, opts, head);
  }

  if (!phaseAtLeast(journal, 'adopted')) {
    // The stack's bind mounts and compose files must be the deployed version while it moves.
    if (head !== journal.from) git(ctx, ['checkout', '--detach', journal.from], 'check out --from');
    try {
      await adopt(ctx, opts, journal);
    } catch (error) {
      if (
        !(error instanceof RollbackIncomplete) &&
        !journal.rollingBack &&
        !journal.stopRequested &&
        !phaseAtLeast(journal, 'stopped')
      ) {
        // Nothing moved yet: return the operator's checkout and forget the attempt. The backup
        // restarts celld itself; this covers a failure it could not recover. If celld cannot be
        // restarted, the journal is kept so the next run restarts it before anything else.
        if (journal.backupStarted) restartLegacyCelld(ctx, journal);
        clearAdoptionJournal(ctx.stateDir);
        git(ctx, ['checkout', '--detach', journal.to], 'restore target checkout');
      }
      throw error;
    }
  }

  removeLegacyContainers(ctx, journal);
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  // The upgrade's own completed marker (or ours, written inside its window) proves it finished:
  // an operator's re-checkout of the target makes HEAD useless as that evidence.
  if (!journal.upgraded && !upgradeCompletedTo(ctx.stateDir, journal.to)) {
    if (
      !existsSync(pendingPath) &&
      git(ctx, ['rev-parse', 'HEAD'], 'git rev-parse HEAD') !== journal.from
    )
      git(ctx, ['checkout', '--detach', journal.from], 'check out --from');
    const finished = journal;
    try {
      await opts.upgrade(withProject(ctx, journal.canonicalProject), {
        to: journal.to,
        checkHealth: opts.checkHealth,
        onCompleted: () => {
          finished.upgraded = true;
          writeAdoptionJournal(ctx.stateDir, finished);
        },
        ...(opts.upgradeBackupDir ? { backupDir: opts.upgradeBackupDir } : {}),
      });
    } catch (error) {
      ctx.log(
        `adoption is complete (project ${journal.canonicalProject}); the upgrade failed. Check out ${journal.to} and rerun the same command to retry it`
      );
      throw error;
    }
  }
  // A completed marker left by a kill is cleaned up the way the upgrade itself would.
  if (upgradeCompletedTo(ctx.stateDir, journal.to)) {
    // The deployed version is the target: the checkout follows it before the marker is cleared.
    if (git(ctx, ['rev-parse', 'HEAD'], 'git rev-parse HEAD') !== journal.to)
      git(ctx, ['checkout', '--detach', journal.to], 'check out the upgraded target');
    readPendingFrom(ctx.stateDir, journal.to);
  }
  clearAdoptionJournal(ctx.stateDir);
  ctx.log('legacy volumes are kept until you remove them after checking the upgraded install:');
  ctx.log(`  docker volume rm ${journal.volumes.map((v) => v.legacy).join(' ')}`);
}
