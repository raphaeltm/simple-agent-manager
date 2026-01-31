import { describe, it, expect, beforeAll } from "vitest";
import "./setup";

describe("D1 Database Resource", () => {
  let databaseModule: typeof import("../resources/database");

  beforeAll(async () => {
    databaseModule = await import("../resources/database");
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

  it("should use stack-based naming convention", async () => {
    const name = await new Promise<string>((resolve) => {
      databaseModule.databaseName.apply((n) => {
        resolve(n);
        return n;
      });
    });
    expect(name).toMatch(/^sam-/);
  });
});
