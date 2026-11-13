import { defineConfig } from "@playwright/test";

// End-to-end tests run against a built Konfab server in a throwaway
// KONFAB_HOME (see tests/e2e/global-setup.ts). Run with `npm run test:e2e`.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:47831",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "light", use: { browserName: "chromium", colorScheme: "light" } },
    { name: "dark", use: { browserName: "chromium", colorScheme: "dark" } },
  ],
});
