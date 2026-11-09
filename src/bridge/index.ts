import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer } from "./tools.js";

const token = process.env.KONFAB_TOKEN;
if (!token) {
  console.error("KONFAB_TOKEN is not set");
  process.exit(1);
}

const retryTimeoutMs = Number(process.env.KONFAB_RETRY_TIMEOUT_MS ?? 60_000);
if (
  !Number.isFinite(retryTimeoutMs) ||
  retryTimeoutMs < 0 ||
  retryTimeoutMs > 600_000
) {
  console.error("KONFAB_RETRY_TIMEOUT_MS must be between 0 and 600000");
  process.exit(1);
}

const server = createBridgeServer({
  baseUrl: process.env.KONFAB_URL ?? "http://127.0.0.1:8787",
  token,
  retryTimeoutMs,
});
await server.connect(new StdioServerTransport());
