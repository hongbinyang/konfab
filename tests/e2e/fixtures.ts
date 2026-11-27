import { test as base } from "@playwright/test";
import { startKonfab } from "./konfab-server.js";

export { expect, type Page } from "@playwright/test";

/**
 * A Konfab server of its own for each worker, so that workers run side by
 * side. The tests read its address and environment as before.
 */
export const test = base.extend<object, { konfab: void }>({
  konfab: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startKonfab();
      process.env.KONFAB_E2E_BASE_URL = server.baseUrl;
      process.env.KONFAB_E2E_ENV = JSON.stringify(server.env);
      try {
        await use();
      } finally {
        server.stop();
      }
    },
    { scope: "worker", auto: true },
  ],
});

/**
 * Tests whose look depends on the theme (a focus ring, the screenshots for
 * review); only these run in the dark theme as well.
 */
export const THEMED = { tag: "@themed" };
