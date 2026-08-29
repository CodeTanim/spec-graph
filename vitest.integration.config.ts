import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file boots its own WASM Postgres instance. Running those migrations
    // concurrently starves initialization and makes otherwise healthy tests
    // fail at the hook timeout on developer machines and shared CI runners.
    fileParallelism: false,
  },
});
