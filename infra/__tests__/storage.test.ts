import { describe, it, expect, beforeAll } from "vitest";
import "./setup";

describe("R2 Bucket Resource", () => {
  let storageModule: typeof import("../resources/storage");

  beforeAll(async () => {
    storageModule = await import("../resources/storage");
  });

  it("should create an R2 bucket resource", async () => {
    expect(storageModule.r2Bucket).toBeDefined();
  });

  it("should export bucket name", async () => {
    expect(storageModule.r2BucketName).toBeDefined();
  });

  it("should use assets suffix in naming", async () => {
    const name = await new Promise<string>((resolve) => {
      storageModule.r2BucketName.apply((n) => {
        resolve(n);
        return n;
      });
    });
    expect(name).toMatch(/-assets$/);
  });
});
