import { describe, expect, it } from "vitest";
import { assertDatabaseDeploymentEnvironment } from "../db";

describe("database deployment environment guard", () => {
  it("allows an unlabeled database during a gradual rollout", () => {
    expect(() =>
      assertDatabaseDeploymentEnvironment(undefined, "production"),
    ).not.toThrow();
  });

  it("allows a database labeled for the current environment", () => {
    expect(() =>
      assertDatabaseDeploymentEnvironment("preview", "preview"),
    ).not.toThrow();
  });

  it("rejects a production database from preview", () => {
    expect(() =>
      assertDatabaseDeploymentEnvironment("production", "preview"),
    ).toThrow("Database environment mismatch");
  });

  it("rejects invalid labels", () => {
    expect(() =>
      assertDatabaseDeploymentEnvironment("staging", "preview"),
    ).toThrow("must be production, preview, or development");
  });
});
