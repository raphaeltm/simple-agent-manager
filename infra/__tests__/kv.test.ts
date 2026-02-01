import { describe, it, expect, beforeAll } from "vitest";
import "./setup";

describe("KV Namespace Resource", () => {
  let kvModule: typeof import("../resources/kv");

  beforeAll(async () => {
    kvModule = await import("../resources/kv");
  });

  it("should create a KV namespace resource", async () => {
    expect(kvModule.kvNamespace).toBeDefined();
  });

  it("should export namespace ID", async () => {
    expect(kvModule.kvNamespaceId).toBeDefined();
  });

  it("should export namespace name", async () => {
    expect(kvModule.kvNamespaceName).toBeDefined();
  });

  it("should use sessions suffix in naming", async () => {
    const name = await new Promise<string>((resolve) => {
      kvModule.kvNamespaceName.apply((n) => {
        resolve(n);
        return n;
      });
    });
    expect(name).toMatch(/-sessions$/);
  });
});
