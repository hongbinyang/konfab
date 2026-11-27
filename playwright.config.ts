import { defineConfig } from "@playwright/test";

// End-to-end tests run against a built Konfab server on a free port in a
// throwaway KONFAB_HOME (see tests/e2e/konfab-server.ts). Run with
// `npm run test:e2e`.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  // Each worker has its own server (tests/e2e/fixtures.ts).
  workers: 4,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "light", use: { browserName: "chromium", colorScheme: "light" } },
    {
      name: "dark",
      // Only what looks different in the dark theme (see THEMED).
      grep: /@themed/,
      use: { browserName: "chromium", colorScheme: "dark" },
    },
  ],
});
