import { describe, it, expect, beforeAll } from "vitest";
import { findRegisteredResource, getOutputValue } from "./setup";

describe("R2 Bucket Resource", () => {
  let storageModule: typeof import("../resources/storage");
  let configModule: typeof import("../resources/config");

  beforeAll(async () => {
    storageModule = await import("../resources/storage");
    configModule = await import("../resources/config");
  });

  it("should create an R2 bucket resource", async () => {
    expect(storageModule.r2Bucket).toBeDefined();
  });

  it("should export bucket name", async () => {
    expect(storageModule.r2BucketName).toBeDefined();
  });

  it("should use assets suffix in naming", async () => {
    const name = await getOutputValue(storageModule.r2BucketName);
    expect(name).toMatch(/-assets$/);
  });

  it("registers the assets bucket with account wiring and WNAM location", () => {
    const bucket = findRegisteredResource(
      `${configModule.prefix}-r2`,
      "cloudflare:index/r2Bucket:R2Bucket"
    );

    expect(bucket.inputs).toMatchObject({
      accountId: "test-account-id-00000000000000000000",
      name: `${configModule.prefix}-${configModule.stack}-assets`,
      location: "WNAM",
    });
  });
});
