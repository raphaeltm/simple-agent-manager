#!/usr/bin/env tsx
/**
 * Sync Pulumi outputs to wrangler.toml
 *
 * This script reads Pulumi stack outputs and updates the wrangler.toml
 * bindings for D1, KV, and R2 resources in the production environment.
 *
 * Usage:
 *   PULUMI_STACK=prod pnpm tsx scripts/deploy/sync-wrangler-config.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as TOML from "@iarna/toml";
import type { PulumiOutputs, WranglerToml, WranglerEnvConfig } from "./types.js";
import { DEPLOYMENT_CONFIG } from "./config.js";

const INFRA_DIR = resolve(import.meta.dirname, "../../infra");
const WRANGLER_TOML_PATH = resolve(import.meta.dirname, "../../apps/api/wrangler.toml");

function getPulumiOutputs(stack: string): PulumiOutputs {
  const command = `pulumi stack output --json --stack ${stack}`;
  console.log(`📦 Fetching Pulumi outputs: ${command}`);

  try {
    const output = execSync(command, {
      cwd: INFRA_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output) as PulumiOutputs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get Pulumi outputs: ${message}`);
  }
}

function loadWranglerToml(): WranglerToml {
  console.log(`📖 Reading wrangler.toml from: ${WRANGLER_TOML_PATH}`);
  const content = readFileSync(WRANGLER_TOML_PATH, "utf-8");
  return TOML.parse(content) as WranglerToml;
}

function saveWranglerToml(config: WranglerToml): void {
  console.log(`💾 Writing updated wrangler.toml`);
  const content = TOML.stringify(config as TOML.JsonMap);
  writeFileSync(WRANGLER_TOML_PATH, content, "utf-8");
}

function updateEnvironmentBindings(
  envConfig: WranglerEnvConfig,
  outputs: PulumiOutputs
): WranglerEnvConfig {
  return {
    ...envConfig,
    // Set account_id for authentication
    account_id: outputs.cloudflareAccountId,
    // Add routes for custom domains
    routes: [
      { pattern: `api.${outputs.stackSummary.baseDomain}`, zone_name: outputs.stackSummary.baseDomain },
      { pattern: `*.${outputs.stackSummary.baseDomain}`, zone_name: outputs.stackSummary.baseDomain }
    ],
    vars: {
      ...envConfig.vars,
      BASE_DOMAIN: outputs.stackSummary.baseDomain,
      VERSION: DEPLOYMENT_CONFIG.version,
    },
    d1_databases: [
      {
        binding: "DATABASE",
        database_name: outputs.d1DatabaseName,
        database_id: outputs.d1DatabaseId,
        migrations_dir: "src/db/migrations",
      },
    ],
    kv_namespaces: [
      {
        binding: "KV",
        id: outputs.kvId,
      },
    ],
    r2_buckets: [
      {
        binding: "R2",
        bucket_name: outputs.r2Name,
      },
    ],
  };
}

async function main(): Promise<void> {
  const stack = process.env.PULUMI_STACK;
  if (!stack) {
    console.error("❌ PULUMI_STACK environment variable is required");
    process.exit(1);
  }

  console.log(`\n🔄 Syncing Pulumi outputs to wrangler.toml`);
  console.log(`   Stack: ${stack}`);
  console.log("");

  // Get Pulumi outputs
  const outputs = getPulumiOutputs(stack);
  console.log(`✅ Got Pulumi outputs:`);
  console.log(`   Base Domain: ${outputs.stackSummary.baseDomain}`);
  console.log(`   D1 Database: ${outputs.d1DatabaseName} (${outputs.d1DatabaseId})`);
  console.log(`   KV Namespace: ${outputs.kvName} (${outputs.kvId})`);
  console.log(`   R2 Bucket: ${outputs.r2Name}`);
  console.log("");

  // Load and update wrangler.toml
  const config = loadWranglerToml();

  // Determine environment key based on stack using centralized config
  const envKey = DEPLOYMENT_CONFIG.getEnvironmentFromStack(stack);

  // Ensure env section exists
  if (!config.env) {
    config.env = {};
  }

  // Ensure environment section exists
  if (!config.env[envKey]) {
    config.env[envKey] = {};
  }

  // Update bindings
  config.env[envKey] = updateEnvironmentBindings(config.env[envKey], outputs);

  // Save updated config
  saveWranglerToml(config);

  console.log(`✅ Updated wrangler.toml [env.${envKey}] with Pulumi resource bindings`);
  console.log("");
}

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
