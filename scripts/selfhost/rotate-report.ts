/**
 * What `rotate` prints: the plan (dry run and the start of a real run) and the summary at the
 * end. Names, phases, counts, row ids and paths only, never a value.
 */
import { join } from 'node:path';

import { EXTERNAL_SECRETS, NOT_ROTATED, type RotatableKey } from './rotate-catalog';
import type { Journal } from './rotate-store';

const PROCEDURE_TEXT: Record<RotatableKey['procedure'], string> = {
  swap: 'new value, deploy, check',
  gateway:
    'Worker accepts old and new, restart Caddy/frps/sam-mx with the new value, Worker accepts only the new one',
  overlap:
    'new key pair with its own kid, published alone; the Worker still accepts callback tokens signed with the old key until the overlap ends, then `rotate --resume` removes it',
  reencrypt:
    'new key current, old key as read fallback; re-encrypt every stored value in bounded pages, verify, wait for values the passes cannot reach to expire, verify again, retire the old key',
  'better-auth':
    'versioned BetterAuth secret; re-encrypt stored OAuth tokens, verify, retire the old secret',
};

/** Bundle entries a key's rotation adds while it is in progress. */
export function transitionalNames(key: RotatableKey): string[] {
  switch (key.procedure) {
    case 'gateway':
      return ['REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE'];
    case 'overlap':
      return [
        'JWT_KEY_ID',
        'JWT_PUBLIC_KEY_PREVIOUS',
        'JWT_PREVIOUS_KEY_ID',
        'JWT_PUBLIC_KEY_PREVIOUS_UNTIL',
      ];
    case 'reencrypt':
      return [`${key.secrets[0]}_PREVIOUS`, 'SAM_KEY_ROTATION_CONTROL_KEY', 'TOKEN_HASH_KEY'];
    case 'better-auth':
      return [
        'BETTER_AUTH_SECRET_VERSION',
        'BETTER_AUTH_SECRET_PREVIOUS',
        'BETTER_AUTH_SECRET_PREVIOUS_VERSION',
        'SAM_KEY_ROTATION_CONTROL_KEY',
      ];
    default:
      return [];
  }
}

function externalLines(bundle: Readonly<Record<string, string>>): string[] {
  const lines = [
    'Not rotated by this command (do these yourself; each is also in deploy/selfhost/README.md):',
  ];
  const present = Object.keys(bundle).sort();
  for (const external of EXTERNAL_SECRETS) {
    const names = present.filter((name) => external.match.test(name));
    if (names.length > 0) lines.push(`  ${names.join(', ')}: ${external.where}`);
  }
  lines.push(
    '  GitHub App secret and private key, OAuth client secrets, SMTP password set in Admin settings: they were encrypted under the old ENCRYPTION_KEY, so anyone holding an old backup and the old key can read them. Replace them at the provider (see above), then in Admin settings.',
    '  Credentials your users stored in SAM (cloud tokens, agent API keys) are in old backups under the old key: ask users to replace them at their providers.',
    '  The fleet bucket credential in deploy/selfhost/.env (AWS_SECRET_ACCESS_KEY): create a new one at your object store, update .env, docker compose up -d, revoke the old one.'
  );
  for (const [name, why] of Object.entries(NOT_ROTATED)) {
    if (bundle[name] !== undefined || name === 'TOKEN_HASH_KEY') lines.push(`  ${name}: ${why}`);
  }
  return lines;
}

export function formatPlan(
  keys: readonly RotatableKey[],
  bundle: Readonly<Record<string, string>>,
  options: { jwtOverlapHours?: number; storedLifetimeMinutes?: number; skipBackup?: boolean }
): string[] {
  const lines = ['Plan (in this order):'];
  if (!options.skipBackup)
    lines.push('  0. backup (pnpm selfhost:backup; celld stops for about 20-45 s)');
  keys.forEach((key, index) => {
    lines.push(`  ${index + 1}. ${key.name}: ${key.secrets.join(', ') || '-'}`);
    lines.push(`     how: ${PROCEDURE_TEXT[key.procedure]}`);
    lines.push(`     users notice: ${key.impact}`);
    lines.push(`     downtime: ${key.downtime}`);
    if (key.name === 'encryption-key') {
      const minutes = options.storedLifetimeMinutes ?? 315;
      lines.push(
        `     finishes: \`rotate --resume\` at least ${minutes} min after the switch (interaction details and bootstrap tokens expire first)`
      );
      if (!bundle.BETTER_AUTH_SECRET)
        lines.push(
          '     pins BETTER_AUTH_SECRET to the current value first (rotate better-auth-secret to replace it)'
        );
      if (!bundle.TOKEN_HASH_KEY)
        lines.push('     pins TOKEN_HASH_KEY to the current value (kept on purpose, see below)');
    }
    if (key.procedure === 'overlap') {
      lines.push(
        `     finishes: \`rotate --resume\` after the ${options.jwtOverlapHours ?? 13} h overlap; until then the old key still verifies callback tokens`
      );
    }
  });
  lines.push(...externalLines(bundle));
  return lines;
}

export function formatSummary(
  journal: Journal,
  bundle: Readonly<Record<string, string>>,
  stateDir: string
): string[] {
  const lines = [`Rotation ${journal.id}:`];
  for (const name of journal.keys) {
    const step = journal.steps[name];
    if (!step) continue;
    let detail = '';
    if (step.phase === 'waiting')
      detail = ` until ${step.waitUntil}: then run pnpm selfhost:secrets rotate --resume`;
    if (step.error) detail += ` (${step.error})`;
    if (step.baseline?.unreadable) {
      const ids = step.baseline.rows.slice(0, 20).map((r) => `${r.location}/${r.id}.${r.column}`);
      detail += `; ${step.baseline.unreadable} value(s) were unreadable before the rotation and were left untouched: ${ids.join(', ')}${step.baseline.unreadable > ids.length ? ', ...' : ''}`;
    }
    if (step.legacyTunnelLeases) {
      detail += `; ${step.legacyTunnelLeases} reverse-tunnel node(s) created before the switch still use a tunnel credential derived from the old key: replace them`;
    }
    lines.push(`  ${name}: ${step.phase}${detail}`);
  }
  if (!journal.finishedAt) {
    lines.push(
      'Not finished yet. The journal is .state/key-agent/rotation/journal.json; rotate --status shows it.'
    );
    return lines;
  }
  const replaced = journal.keys.filter((name) => journal.steps[name]?.phase === 'done');
  lines.push(
    'Done. The bundle was resealed without any transitional value.',
    `Old copies of ${replaced.join(', ') || 'nothing'} are now worthless for signing or decrypting new data, so these are now meaningful:`,
    '  pnpm selfhost:secrets plaintext --purge --confirm <CELLD_BUCKET>   (old celld deploy versions)',
    '  deleting backups taken before this rotation: they hold the old keys AND the data encrypted under them, so they stay as sensitive as before; keep only what you need for recovery',
    journal.backupDir
      ? `  (the backup this rotation took first, ${journal.backupDir}, is one of them)`
      : '',
    `  ${join(stateDir, 'key-agent', 'rotation', journal.id)}/: the old values, sealed with your key provider (the rollback source). Delete it once you are satisfied.`,
    ...externalLines(bundle)
  );
  return lines.filter(Boolean);
}
