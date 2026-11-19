/**
 * Durable Objects only the self-host (celld) build has.
 *
 * `apps/api/wrangler.toml` is the Cloudflare Worker's configuration and must not name these
 * classes: a Cloudflare Durable Object migration cannot be taken back, and the Cloudflare bundle
 * must not carry their code. The celld config (`buildCelldConfig`) appends each one's binding
 * and migration after wrangler.toml's, and the generated celld entry (`celld-project.ts`) exports
 * the class from `SELFHOST_ENTRY_MODULE`, which the shared entry `apps/api/src/index.ts` never
 * imports. Today that module is hosted git's; a second self-host-only class must be exported from
 * the same module (tests/unit/selfhost/selfhost-only-modules.test.ts checks every class is).
 *
 * celld 0.6.3 validates migrations declaratively (a tag or a class may appear once; a class with
 * storage must be declared in `new_sqlite_classes`). Observed with `celld dev`, which keeps state
 * across restarts: an object written while this class was wrangler.toml's `v23` keeps its data
 * once the class is declared under this tag. Bucket-mode `celld deploy` over an existing box is not
 * yet verified (task tasks/archive/2026-11-15-hosted-git-selfhost-only-build.md).
 */

export interface SelfhostDurableObject {
  /** Worker binding name (`Env.HOSTED_GIT`). */
  binding: string;
  /** Class exported by `SELFHOST_ENTRY_MODULE`. */
  className: string;
  /** celld migration tag; distinct from wrangler.toml's `vN` tags so the two never collide. */
  migrationTag: string;
}

/** The module under apps/api/src that the generated celld entry imports for these classes. */
export const SELFHOST_ENTRY_MODULE = 'selfhost/build.ts';

export const SELFHOST_DURABLE_OBJECTS: readonly SelfhostDurableObject[] = [
  // SAM-hosted git repositories (one per repository); selfhost/hosted-git/local-backend.ts selects it
  // with HOSTED_GIT_BACKEND=durable-object (SELFHOST_VAR_OVERRIDES).
  { binding: 'HOSTED_GIT', className: 'HostedGitRepo', migrationTag: 'selfhost-hosted-git-v1' },
];

interface DurableObjectConfig {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
}

/**
 * Appends every self-host-only binding and migration to a config translated from wrangler.toml.
 * Throws when wrangler.toml already uses a binding name, class or tag, so the class cannot end up
 * declared twice or back in the Cloudflare configuration unnoticed.
 */
export function appendSelfhostDurableObjects(config: DurableObjectConfig, report: string[]): void {
  const bindings = new Set(config.durable_objects.bindings.map((b) => b.name));
  const classes = new Set([
    ...config.durable_objects.bindings.map((b) => b.class_name),
    ...config.migrations.flatMap((m) => m.new_sqlite_classes),
  ]);
  const tags = new Set(config.migrations.map((m) => m.tag));
  for (const object of SELFHOST_DURABLE_OBJECTS) {
    if (
      bindings.has(object.binding) ||
      classes.has(object.className) ||
      tags.has(object.migrationTag)
    ) {
      throw new Error(
        `celld config: wrangler.toml declares ${object.binding}, ${object.className} or ` +
          `${object.migrationTag}, which only the self-host build may declare ` +
          '(scripts/selfhost/selfhost-durable-objects.ts)'
      );
    }
    config.durable_objects.bindings.push({ name: object.binding, class_name: object.className });
    config.migrations.push({ tag: object.migrationTag, new_sqlite_classes: [object.className] });
    report.push(
      `self-host Durable Object ${object.binding} (${object.className}), migration ${object.migrationTag}`
    );
  }
}
