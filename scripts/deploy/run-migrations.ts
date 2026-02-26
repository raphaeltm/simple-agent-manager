#!/usr/bin/env tsx
/**
 * Run database migrations
 *
 * This script reads the database name from wrangler.toml and runs migrations.
 * It supports both local and remote migrations.
 *
 * Usage:
 *   pnpm tsx scripts/deploy/run-migrations.ts [--env staging|production] [--local]
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as TOML from "@iarna/toml";
import type { WranglerToml } from "./types.js";

const WRANGLER_TOML_PATH = resolve(import.meta.dirname, "../../apps/api/wrangler.toml");

function loadWranglerToml(): WranglerToml {
  const content = readFileSync(WRANGLER_TOML_PATH, "utf-8");
  return TOML.parse(content) as WranglerToml;
}

function getDatabaseNames(config: WranglerToml, environment?: string): Array<{ binding: string; name: string }> {
  const databases = environment && config.env?.[environment]?.d1_databases
    ? config.env[environment].d1_databases
    : config.d1_databases;

  if (!databases || databases.length === 0) {
    throw new Error("No D1 database configuration found");
  }

  return databases.map((db) => ({
    binding: db.binding,
    name: db.database_name,
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf("--env");
  const environment = envIndex >= 0 ? args[envIndex + 1] : undefined;
  const isLocal = args.includes("--local");

  const config = loadWranglerToml();
  const databases = getDatabaseNames(config, environment);

  console.log(`🚀 Running migrations for ${databases.length} database(s)`);
  console.log(`   Environment: ${environment || "development"}`);
  console.log(`   Mode: ${isLocal ? "local" : "remote"}`);
  console.log(`   Databases: ${databases.map((db) => `${db.binding} (${db.name})`).join(", ")}\n`);

  for (const db of databases) {
    console.log(`\n📦 Migrating ${db.binding} (${db.name})...\n`);

    const command = `npx wrangler d1 migrations apply ${db.name} ${isLocal ? "--local" : "--remote"}${environment ? ` --env ${environment}` : ""}`;

    console.log(`Executing: ${command}\n`);

    try {
      execSync(command, {
        stdio: "inherit",
        cwd: resolve(import.meta.dirname, "../../apps/api"),
      });
      console.log(`\n✅ ${db.binding} migrations applied successfully!`);
    } catch (error) {
      console.error(`\n❌ Failed to apply migrations for ${db.binding} (${db.name})`);
      process.exit(1);
    }
  }

  console.log(`\n✅ All migrations applied successfully!`);
}

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});