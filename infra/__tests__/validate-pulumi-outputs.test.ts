import { describe, expect, it } from "vitest";
import type { PulumiOutputs } from "../../scripts/deploy/types.js";
import { validatePulumiOutputs } from "../../scripts/deploy/sync-wrangler-config.js";

function makeValidOutputs(): PulumiOutputs {
  return {
    d1DatabaseId: "db-123",
    d1DatabaseName: "sam-prod",
    observabilityD1DatabaseId: "obs-db-456",
    observabilityD1DatabaseName: "sam-prod-obs",
    kvId: "kv-789",
    kvName: "sam-prod-sessions",
    r2Name: "sam-prod-assets",
    cloudflareAccountId: "cf-account-abc",
    pagesName: "sam-web-prod",
    dnsIds: { api: "dns-1", app: "dns-2", wildcard: "dns-3" },
    hostnames: { api: "api.example.com", app: "app.example.com" },
    stackSummary: {
      stack: "prod",
      baseDomain: "example.com",
      resources: { d1: "db-123", kv: "kv-789", r2: "sam-prod-assets" },
    },
  };
}

describe("validatePulumiOutputs", () => {
  it("accepts valid outputs without throwing", () => {
    expect(() => validatePulumiOutputs(makeValidOutputs())).not.toThrow();
  });

  it("throws when a required top-level field is missing", () => {
    const outputs = makeValidOutputs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (outputs as any).d1DatabaseId = "";
    expect(() => validatePulumiOutputs(outputs)).toThrow(
      /D1 Database ID \(d1DatabaseId\)/
    );
  });

  it("throws when multiple required fields are missing", () => {
    const outputs = makeValidOutputs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (outputs as any).kvId = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (outputs as any).r2Name = null;
    expect(() => validatePulumiOutputs(outputs)).toThrow(
      /KV Namespace ID.*R2 Bucket Name/s
    );
  });

  it("throws when stackSummary.baseDomain is missing", () => {
    const outputs = makeValidOutputs();
    outputs.stackSummary = {
      ...outputs.stackSummary,
      baseDomain: "",
    };
    expect(() => validatePulumiOutputs(outputs)).toThrow(
      /stackSummary\.baseDomain/
    );
  });

  it("throws when stackSummary is undefined", () => {
    const outputs = makeValidOutputs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (outputs as any).stackSummary = undefined;
    expect(() => validatePulumiOutputs(outputs)).toThrow(
      /stackSummary\.baseDomain/
    );
  });
});
