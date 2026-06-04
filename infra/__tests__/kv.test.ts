import { describe, it, expect, beforeAll } from "vitest";
import { findRegisteredResource, getOutputValue } from "./setup";

describe("KV Namespace Resource", () => {
  let kvModule: typeof import("../resources/kv");
  let configModule: typeof import("../resources/config");

  beforeAll(async () => {
    kvModule = await import("../resources/kv");
    configModule = await import("../resources/config");
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
    const name = await getOutputValue(kvModule.kvNamespaceName);
    expect(name).toMatch(/-sessions$/);
  });

  it("registers the sessions namespace with account wiring", () => {
    const namespace = findRegisteredResource(
      `${configModule.prefix}-kv`,
      "cloudflare:index/workersKvNamespace:WorkersKvNamespace"
    );

    expect(namespace.inputs).toMatchObject({
      accountId: "test-account-id-00000000000000000000",
      title: `${configModule.prefix}-${configModule.stack}-sessions`,
    });
  });
});
