import { describe, it, expect, beforeAll } from "vitest";
import { findRegisteredResource, getOutputValue } from "./setup";

describe("D1 Database Resource", () => {
  let databaseModule: typeof import("../resources/database");
  let configModule: typeof import("../resources/config");

  beforeAll(async () => {
    databaseModule = await import("../resources/database");
    configModule = await import("../resources/config");
  });

  it("should create a D1 database resource", async () => {
    expect(databaseModule.database).toBeDefined();
    expect(databaseModule.observabilityDatabase).toBeDefined();
  });

  it("should export database ID", async () => {
    expect(databaseModule.databaseId).toBeDefined();
  });

  it("should export database name", async () => {
    expect(databaseModule.databaseName).toBeDefined();
  });

  it("should compose the database name from prefix and stack", async () => {
    const name = await getOutputValue(databaseModule.databaseName);
    expect(name).toBe(`${configModule.prefix}-${configModule.stack}`);
  });

  it("registers the main D1 database with account wiring and readReplication ignored", () => {
    const database = findRegisteredResource(
      `${configModule.prefix}-database`,
      "cloudflare:index/d1Database:D1Database"
    );

    expect(database.inputs).toMatchObject({
      accountId: "test-account-id-00000000000000000000",
      name: `${configModule.prefix}-${configModule.stack}`,
    });
    expect(database.options.ignoreChanges).toEqual(["readReplication"]);
  });

  it("registers the observability D1 database with account wiring and readReplication ignored", async () => {
    const observabilityDatabase = findRegisteredResource(
      `${configModule.prefix}-observability`,
      "cloudflare:index/d1Database:D1Database"
    );

    expect(observabilityDatabase.inputs).toMatchObject({
      accountId: "test-account-id-00000000000000000000",
      name: `${configModule.prefix}-observability-${configModule.stack}`,
    });
    expect(observabilityDatabase.options.ignoreChanges).toEqual(["readReplication"]);
    await expect(getOutputValue(databaseModule.observabilityDatabaseName)).resolves.toBe(
      `${configModule.prefix}-observability-${configModule.stack}`
    );
  });
});
