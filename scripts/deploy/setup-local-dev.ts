#!/usr/bin/env tsx
/**
 * Setup local development environment
 *
 * This script configures the local development environment by creating
 * local D1 database, KV namespace, and R2 bucket, then updating wrangler.toml
 * with the correct IDs.
 *
 * Usage:
 *   pnpm tsx scripts/deploy/setup-local-dev.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as TOML from "@iarna/toml";
import type { WranglerToml } from "./types.js";

const WRANGLER_TOML_PATH = resolve(import.meta.dirname, "../../apps/api/wrangler.toml");

interface LocalResources {
  d1DatabaseId?: string;
  kvNamespaceId?: string;
  r2BucketCreated: boolean;
}

function execCommand(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error: any) {
    if (error.stderr) {
      const stderr = error.stderr.toString();
      // Check if resource already exists
      if (stderr.includes("already exists")) {
        console.log(`  ⚠️ Resource already exists (continuing...)`);
        return "";
      }
    }
    throw error;
  }
}

function createD1Database(name: string): string | undefined {
  console.log(`📦 Creating local D1 database: ${name}`);
  try {
    const output = execCommand(`npx wrangler d1 create ${name} --local 2>&1`);
    // Parse the database ID from output
    const match = output.match(/database_id\s*=\s*"([^"]+)"/);
    if (match) {
      console.log(`  ✅ Created with ID: ${match[1]}`);
      return match[1];
    }

    // Try to get existing database ID
    const listOutput = execCommand(`npx wrangler d1 list --local --json 2>/dev/null || echo "[]"`);
    try {
      const databases = JSON.parse(listOutput);
      const existing = databases.find((db: any) => db.name === name);
      if (existing) {
        console.log(`  ✅ Found existing database with ID: ${existing.uuid}`);
        return existing.uuid;
      }
    } catch {
      // Ignore JSON parse errors
    }
  } catch (error) {
    console.log(`  ⚠️ Could not create/find database (may already exist)`);
  }
  return undefined;
}

function createKVNamespace(title: string): string | undefined {
  console.log(`📦 Creating local KV namespace: ${title}`);
  try {
    const output = execCommand(`npx wrangler kv:namespace create "${title}" --local --preview 2>&1`);
    // Parse the namespace ID from output
    const match = output.match(/id\s*=\s*"([^"]+)"/);
    if (match) {
      console.log(`  ✅ Created with ID: ${match[1]}`);
      return match[1];
    }

    // Try to list existing namespaces
    const listOutput = execCommand(`npx wrangler kv:namespace list --local --json 2>/dev/null || echo "[]"`);
    try {
      const namespaces = JSON.parse(listOutput);
      const existing = namespaces.find((ns: any) => ns.title === title);
      if (existing) {
        console.log(`  ✅ Found existing namespace with ID: ${existing.id}`);
        return existing.id;
      }
    } catch {
      // Ignore JSON parse errors
    }
  } catch (error) {
    console.log(`  ⚠️ Could not create/find KV namespace (may already exist)`);
  }
  return undefined;
}

function createR2Bucket(name: string): boolean {
  console.log(`📦 Creating local R2 bucket: ${name}`);
  try {
    execCommand(`npx wrangler r2 bucket create ${name} --local 2>&1`);
    console.log(`  ✅ Created successfully`);
    return true;
  } catch (error) {
    console.log(`  ⚠️ Could not create bucket (may already exist)`);
    return false;
  }
}

function loadWranglerToml(): WranglerToml {
  const content = readFileSync(WRANGLER_TOML_PATH, "utf-8");
  return TOML.parse(content) as WranglerToml;
}

function saveWranglerToml(config: WranglerToml): void {
  const content = TOML.stringify(config as TOML.JsonMap);
  writeFileSync(WRANGLER_TOML_PATH, content, "utf-8");
}

function updateDevConfiguration(config: WranglerToml, resources: LocalResources): void {
  // Update default/dev configuration
  if (!config.vars) {
    config.vars = {};
  }

  // Set development domain (using port from environment or default)
  const port = process.env.WRANGLER_PORT || "8787";
  config.vars.BASE_DOMAIN = `localhost:${port}`;

  // Update D1 database if we have an ID
  if (resources.d1DatabaseId && config.d1_databases?.[0]) {
    config.d1_databases[0].database_id = resources.d1DatabaseId;
    config.d1_databases[0].database_name = "workspaces-dev";
  }

  // Update KV namespace if we have an ID
  if (resources.kvNamespaceId && config.kv_namespaces?.[0]) {
    config.kv_namespaces[0].id = resources.kvNamespaceId;
  }

  // R2 bucket name stays the same (workspaces-dev-assets)
  // as it's referenced by name, not ID
}

async function main(): Promise<void> {
  console.log("🚀 Setting up local development environment\n");

  const resources: LocalResources = {
    r2BucketCreated: false,
  };

  // Create local resources
  console.log("Creating local resources...\n");

  // Create D1 database
  const d1Id = createD1Database("workspaces-dev");
  if (d1Id) {
    resources.d1DatabaseId = d1Id;
  }

  // Create KV namespace
  const kvId = createKVNamespace("workspaces-dev-sessions");
  if (kvId) {
    resources.kvNamespaceId = kvId;
  }

  // Create R2 bucket
  resources.r2BucketCreated = createR2Bucket("workspaces-dev-assets");

  console.log("\n📝 Updating wrangler.toml...\n");

  // Load and update wrangler.toml
  const config = loadWranglerToml();
  updateDevConfiguration(config, resources);
  saveWranglerToml(config);

  console.log("✅ Local development environment configured!\n");
  console.log("Summary:");
  console.log("  • D1 Database:", resources.d1DatabaseId ? "Configured" : "Using placeholder (will work locally)");
  console.log("  • KV Namespace:", resources.kvNamespaceId ? "Configured" : "Using placeholder (will work locally)");
  console.log("  • R2 Bucket:", resources.r2BucketCreated ? "Created" : "May already exist");
  console.log("  • Base Domain: localhost:8787");
  console.log("\nYou can now run: pnpm dev");
}

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});