import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["evaluation/live-semantic-evaluation.test.ts"],
    testTimeout: 600_000,
  },
});
