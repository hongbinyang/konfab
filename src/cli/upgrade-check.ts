import { databasePath, konfabHome } from "../server/config.js";
import { checkUpgrade } from "../server/db/upgrade-check.js";

// Checks whether replacing roles with skills will succeed, without changing the database.
const result = checkUpgrade(databasePath(konfabHome()));
console.log(result.report);
process.exitCode = result.ok ? 0 : 1;
