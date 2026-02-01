#!/usr/bin/env tsx
/**
 * Generate security keys for deployment
 *
 * Outputs keys in a format suitable for GitHub Actions workflow.
 * If FORCE_REGENERATE is false and keys already exist as secrets,
 * this script does nothing.
 *
 * Usage:
 *   FORCE_REGENERATE=false pnpm tsx scripts/deploy/generate-keys.ts
 */

import * as crypto from "node:crypto";

function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

function generateKeyPair(): { publicKey: string; privateKey: string; keyId: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const keyId = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  return { publicKey, privateKey, keyId };
}

async function main(): Promise<void> {
  const forceRegenerate = process.env.FORCE_REGENERATE === "true";

  // Check if keys already exist (would be passed as environment variables)
  const existingEncryptionKey = process.env.ENCRYPTION_KEY;
  const existingJwtPrivateKey = process.env.JWT_PRIVATE_KEY;

  if (!forceRegenerate && existingEncryptionKey && existingJwtPrivateKey) {
    console.log("✅ Security keys already configured, skipping generation");
    // Signal to workflow that keys were not generated
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(githubOutput, `keys_generated=false\n`);
    }
    return;
  }

  console.log("🔑 Generating security keys for deployment\n");

  const encryptionKey = generateEncryptionKey();
  const { publicKey, privateKey, keyId } = generateKeyPair();

  console.log("Generated keys:");
  console.log(`  - Encryption key: ${encryptionKey.substring(0, 10)}...`);
  console.log(`  - JWT key ID: ${keyId}`);
  console.log("");

  // Output as GitHub Actions format for setting secrets
  // These can be captured and used with wrangler secret put
  console.log("::group::Generated Keys (for wrangler secret put)");
  console.log(`ENCRYPTION_KEY=${encryptionKey}`);
  console.log(`JWT_KEY_ID=${keyId}`);
  console.log(`JWT_PUBLIC_KEY=${publicKey.replace(/\n/g, "\\n")}`);
  console.log(`JWT_PRIVATE_KEY=${privateKey.replace(/\n/g, "\\n")}`);
  console.log("::endgroup::");

  // Write to GitHub output if available
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const { appendFileSync } = await import("node:fs");

    // Signal that keys were generated
    appendFileSync(githubOutput, `keys_generated=true\n`);

    // Single-line values
    appendFileSync(githubOutput, `encryption_key=${encryptionKey}\n`);
    appendFileSync(githubOutput, `jwt_key_id=${keyId}\n`);

    // Multi-line PEM keys using GitHub Actions heredoc delimiter syntax
    // Format: name<<DELIMITER\nvalue\nDELIMITER\n
    const delimiter = `EOF_${Date.now()}`;
    appendFileSync(githubOutput, `jwt_private_key<<${delimiter}\n${privateKey}${delimiter}\n`);
    appendFileSync(githubOutput, `jwt_public_key<<${delimiter}\n${publicKey}${delimiter}\n`);

    console.log("📝 Wrote all keys to GITHUB_OUTPUT (including multi-line PEM keys)");
  }

  console.log("\n⚠️  These keys are stored in Cloudflare Worker secrets after deployment.");
}

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
