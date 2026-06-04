import { describe, it, expect, beforeAll } from "vitest";
import { findRegisteredResource, getOutputValue } from "./setup";

describe("DNS Records Resources", () => {
  let dnsModule: typeof import("../resources/dns");
  let configModule: typeof import("../resources/config");
  let pagesModule: typeof import("../resources/pages");

  beforeAll(async () => {
    dnsModule = await import("../resources/dns");
    configModule = await import("../resources/config");
    pagesModule = await import("../resources/pages");
  });

  it("registers API and wildcard records as proxied worker CNAMEs", () => {
    const expectedWorkerHost = `${configModule.prefix}-api-${configModule.stack}.workers.dev`;

    const apiRecord = findRegisteredResource(
      `${configModule.prefix}-dns-api`,
      "cloudflare:index/record:Record"
    );
    expect(apiRecord.inputs).toMatchObject({
      zoneId: "test-zone-id-000000000000000000000",
      name: "api",
      type: "CNAME",
      content: expectedWorkerHost,
      proxied: true,
      ttl: 1,
    });

    const wildcardRecord = findRegisteredResource(
      `${configModule.prefix}-dns-wildcard`,
      "cloudflare:index/record:Record"
    );
    expect(wildcardRecord.inputs).toMatchObject({
      zoneId: "test-zone-id-000000000000000000000",
      name: "*",
      type: "CNAME",
      content: expectedWorkerHost,
      proxied: true,
      ttl: 1,
    });
  });

  it("uses the actual Pages project subdomain for app DNS", async () => {
    const appRecord = findRegisteredResource(
      `${configModule.prefix}-dns-app`,
      "cloudflare:index/record:Record"
    );
    const pagesSubdomain = await getOutputValue(pagesModule.pagesProject.subdomain);
    const appRecordContent = await getOutputValue(
      appRecord.inputs.content as typeof pagesModule.pagesProject.subdomain
    );

    expect(appRecord.inputs).toMatchObject({
      zoneId: "test-zone-id-000000000000000000000",
      name: "app",
      type: "CNAME",
      proxied: true,
      ttl: 1,
    });
    expect(appRecordContent).toBe(pagesSubdomain);
    expect(appRecordContent).not.toBe(
      `${configModule.prefix}-web-${configModule.stack}.pages.dev`
    );
  });

  it("registers the VM worker route exclusion without a script", () => {
    const route = findRegisteredResource(
      `${configModule.prefix}-route-vm-exclusion`,
      "cloudflare:index/workersRoute:WorkersRoute"
    );

    expect(route.inputs).toMatchObject({
      zoneId: "test-zone-id-000000000000000000000",
      pattern: "*.vm.example.com/*",
    });
    expect(route.inputs).not.toHaveProperty("scriptName");
  });

  it("should export DNS record IDs object", async () => {
    expect(dnsModule.dnsRecordIds).toBeDefined();
    expect(dnsModule.dnsRecordIds.api).toBeDefined();
    expect(dnsModule.dnsRecordIds.app).toBeDefined();
    expect(dnsModule.dnsRecordIds.wildcard).toBeDefined();
  });

  it("should export DNS hostnames", async () => {
    await expect(getOutputValue(dnsModule.dnsHostnames.api)).resolves.toBe("api.example.com");
    await expect(getOutputValue(dnsModule.dnsHostnames.app)).resolves.toBe("app.example.com");
    await expect(getOutputValue(dnsModule.dnsHostnames.vmBackend)).resolves.toBe(
      "*.vm.example.com"
    );
  });
});
