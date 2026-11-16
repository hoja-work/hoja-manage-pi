import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@pi-swarm/core": resolve(import.meta.dirname, "packages/runtime/core/src/index.ts") },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", ".pi/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["tests/setup/isolate-state.ts"],
    testTimeout: 20000,
  },
});
