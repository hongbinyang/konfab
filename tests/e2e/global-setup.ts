import { startKonfab } from "./konfab-server.js";

export default async function globalSetup(): Promise<() => void> {
  const server = await startKonfab();
  process.env.KONFAB_E2E_BASE_URL = server.baseUrl;
  process.env.KONFAB_E2E_ENV = JSON.stringify(server.env);
  return server.stop;
}
