import { describe, it, expect, beforeAll } from "vitest";
import "./setup";

describe("D1 Database Resource", () => {
  let databaseModule: typeof import("../resources/database");
  let configModule: typeof import("../resources/config");

  beforeAll(async () => {
    databaseModule = await import("../resources/database");
    configModule = await import("../resources/config");
  });

  it("should create a D1 database resource", async () => {
    expect(databaseModule.database).toBeDefined();
  });

  it("should export database ID", async () => {
    expect(databaseModule.databaseId).toBeDefined();
  });

  it("should export database name", async () => {
    expect(databaseModule.databaseName).toBeDefined();
  });

  it("should compose the database name from prefix and stack", async () => {
    const name = await new Promise<string>((resolve) => {
      databaseModule.databaseName.apply((n) => {
        resolve(n);
        return n;
      });
    });
    expect(name).toBe(`${configModule.prefix}-${configModule.stack}`);
  });
});
