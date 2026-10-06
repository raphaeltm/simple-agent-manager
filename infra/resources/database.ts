import * as cloudflare from "@pulumi/cloudflare";
import { accountId, prefix, stack } from "./config";

export const database = new cloudflare.D1Database(`${prefix}-database`, {
  accountId: accountId,
  name: `${prefix}-${stack}`,
}, {
  // readReplication is returned by CF API on import but cannot be set to null
  // via the API. Ignore changes to avoid spurious update failures.
  // readReplication is OWNED BY THE DEPLOY PIPELINE, not by Pulumi.
  //
  // Two reasons this stays ignored:
  //  1. The CF API returns readReplication on import but cannot be set to null, so leaving it
  //     unmanaged here avoided spurious update failures. That is still true.
  //  2. `scripts/deploy/configure-d1-read-replication.sh` now PUTs `{mode: "auto"}` on every
  //     deploy so the Sessions API in apps/api/src/lib/d1-session.ts can serve reads from a
  //     nearby replica. Managing the same field here would make `pulumi refresh` + `up` fight
  //     that script, and — worse — put a diff on a live production D1 whose worst case is the
  //     provider replacing the resource (.claude/rules/31-migration-safety.md).
  //
  // If you ever move this into Pulumi, prove first that readReplication is an in-place update
  // and not a replacement trigger for the installed provider version.
  ignoreChanges: ["readReplication"],
});

export const databaseId = database.id;
export const databaseName = database.name;

// Observability D1 — dedicated database for error storage (spec 023)
// Isolated from main DATABASE to prevent error volume from affecting core queries
export const observabilityDatabase = new cloudflare.D1Database(`${prefix}-observability`, {
  accountId: accountId,
  name: `${prefix}-observability-${stack}`,
}, {
  // readReplication is OWNED BY THE DEPLOY PIPELINE, not by Pulumi.
  //
  // Two reasons this stays ignored:
  //  1. The CF API returns readReplication on import but cannot be set to null, so leaving it
  //     unmanaged here avoided spurious update failures. That is still true.
  //  2. `scripts/deploy/configure-d1-read-replication.sh` now PUTs `{mode: "auto"}` on every
  //     deploy so the Sessions API in apps/api/src/lib/d1-session.ts can serve reads from a
  //     nearby replica. Managing the same field here would make `pulumi refresh` + `up` fight
  //     that script, and — worse — put a diff on a live production D1 whose worst case is the
  //     provider replacing the resource (.claude/rules/31-migration-safety.md).
  //
  // If you ever move this into Pulumi, prove first that readReplication is an in-place update
  // and not a replacement trigger for the installed provider version.
  ignoreChanges: ["readReplication"],
});

export const observabilityDatabaseId = observabilityDatabase.id;
export const observabilityDatabaseName = observabilityDatabase.name;
