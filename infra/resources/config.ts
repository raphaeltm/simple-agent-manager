import * as crypto from "node:crypto";
import * as pulumi from "@pulumi/pulumi";

const pulumiConfig = new pulumi.Config();

export const accountId = pulumiConfig.require("cloudflareAccountId");
export const zoneId = pulumiConfig.get("cloudflareZoneId") || "";
export const baseDomain = pulumiConfig.get("baseDomain") || "";
export const stack = pulumi.getStack();

/**
 * Resource name prefix — used to namespace all Cloudflare resources.
 *
 * If `resourcePrefix` is explicitly set in Pulumi config, that value is used.
 * Otherwise, a short 6-character hash is derived from `baseDomain` so that
 * forks automatically get unique resource names without extra configuration.
 * This prevents Cloudflare Pages project name collisions (which are globally
 * unique) and Worker name collisions across different deployments.
 */
export const prefix = pulumiConfig.get("resourcePrefix") || derivePrefix(baseDomain);

function derivePrefix(domain: string): string {
  if (!domain) return "sam";
  const hash = crypto.createHash("sha256").update(domain).digest("hex");
  // Use first 6 hex chars, prefixed with 's' to ensure it starts with a letter
  // (Cloudflare resource names must start with a letter)
  return `s${hash.slice(0, 6)}`;
}
