import { describe, it, expect, beforeAll } from "vitest";
import "./setup";

describe("DNS Records Resources", () => {
  let dnsModule: typeof import("../resources/dns");

  beforeAll(async () => {
    dnsModule = await import("../resources/dns");
  });

  it("should create API DNS record", async () => {
    expect(dnsModule.apiDnsRecord).toBeDefined();
  });

  it("should create App DNS record", async () => {
    expect(dnsModule.appDnsRecord).toBeDefined();
  });

  it("should create wildcard DNS record", async () => {
    expect(dnsModule.wildcardDnsRecord).toBeDefined();
  });

  it("should export DNS record IDs object", async () => {
    expect(dnsModule.dnsRecordIds).toBeDefined();
    expect(dnsModule.dnsRecordIds.api).toBeDefined();
    expect(dnsModule.dnsRecordIds.app).toBeDefined();
    expect(dnsModule.dnsRecordIds.wildcard).toBeDefined();
  });

  it("should export DNS hostnames", async () => {
    expect(dnsModule.dnsHostnames).toBeDefined();
    expect(dnsModule.dnsHostnames.api).toBeDefined();
    expect(dnsModule.dnsHostnames.app).toBeDefined();
  });
});
