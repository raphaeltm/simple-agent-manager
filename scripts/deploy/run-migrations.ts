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

function getDatabaseName(config: WranglerToml, environment?: string): string {
  if (environment && config.env?.[environment]?.d1_databases?.[0]) {
    return config.env[environment].d1_databases[0].database_name;
  }
  if (config.d1_databases?.[0]) {
    return config.d1_databases[0].database_name;
  }
  throw new Error("No D1 database configuration found");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf("--env");
  const environment = envIndex >= 0 ? args[envIndex + 1] : undefined;
  const isLocal = args.includes("--local");

  const config = loadWranglerToml();
  const dbName = getDatabaseName(config, environment);

  console.log(`🚀 Running migrations for database: ${dbName}`);
  console.log(`   Environment: ${environment || "development"}`);
  console.log(`   Mode: ${isLocal ? "local" : "remote"}\n`);

  const command = `npx wrangler d1 migrations apply ${dbName} ${isLocal ? "--local" : "--remote"}${environment ? ` --env ${environment}` : ""}`;

  console.log(`Executing: ${command}\n`);

  try {
    execSync(command, {
      stdio: "inherit",
      cwd: resolve(import.meta.dirname, "../../apps/api"),
    });
    console.log("\n✅ Migrations applied successfully!");
  } catch (error) {
    console.error("\n❌ Failed to apply migrations");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});