import { parseConfig } from "./config.js";
import { createPool, migrate } from "./db/pool.js";

const pool = createPool(parseConfig());
try {
  await migrate(pool);
} finally {
  await pool.end();
}
