import type { Database } from "bun:sqlite";
import type { Config } from "../config";

/** What a sprint startup hook receives, once the database is open and before the server starts. */
export interface StartupContext {
  db: Database;
  config: Config;
}
