/**
 * `serve` records in its lock where it listens (see s3-serve-start.ts). What it records must be what the socket is
 * bound to, not what the configuration said: a configured port of 0 means "any port", and the lock must carry the
 * one that was given.
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { startServer, type RunningServer } from "../src/ws/server";

let server: RunningServer | undefined;
let db: Database | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
  db?.close();
  db = undefined;
});

test("a running server reports the host and the port it is bound to", () => {
  db = openDatabase(":memory:");
  const config: Config = {
    host: "127.0.0.1", port: 0, dbPath: ":memory:", pidPath: "", logPath: "", providers: [],
    firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000, helloTimeoutMs: 2000, frameLogCapacity: 100,
    jobPollMs: 1000, maxConcurrentTurns: 4, pluginsPath: "",
  };
  server = startServer(config, db, new Router([], new HealthTracker()));
  expect(server.hostname).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);
});
