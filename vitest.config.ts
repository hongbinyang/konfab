import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server/index.ts", "src/bridge/index.ts", "src/cli/**"],
      reporter: ["text-summary", "text"],
    },
  },
});
