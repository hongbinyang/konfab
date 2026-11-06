import {
  databasePath,
  ensureHome,
  konfabHome,
  loadConfig,
} from "../server/config.js";
import { createRuntime } from "../server/runtime.js";

const home = konfabHome();
ensureHome(home);
const config = loadConfig(home);
const { db, service } = createRuntime(databasePath(home), config);
console.log(
  `http://127.0.0.1:${config.server.port}/login?code=${service.createLoginCode()}`,
);
db.close();
