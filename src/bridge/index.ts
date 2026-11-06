import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer } from "./tools.js";

const token = process.env.KONFAB_TOKEN;
if (!token) {
  console.error("KONFAB_TOKEN is not set");
  process.exit(1);
}

const server = createBridgeServer({
  baseUrl: process.env.KONFAB_URL ?? "http://127.0.0.1:8787",
  token,
});
await server.connect(new StdioServerTransport());
