import * as cloudflare from "@pulumi/cloudflare";
import { accountId, prefix, stack } from "./config";

export const database = new cloudflare.D1Database(`${prefix}-database`, {
  accountId: accountId,
  name: `${prefix}-${stack}`,
}, {
  // readReplication is returned by CF API on import but cannot be set to null
  // via the API. Ignore changes to avoid spurious update failures.
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
  ignoreChanges: ["readReplication"],
});

export const observabilityDatabaseId = observabilityDatabase.id;
export const observabilityDatabaseName = observabilityDatabase.name;
