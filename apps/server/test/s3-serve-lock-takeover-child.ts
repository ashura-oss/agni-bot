/**
 * Child process for s3-serve-lock-takeover.test.ts (not a test itself). It takes the serve lock once per round, at the
 * moment the parent says go, and reports whether it got it. argv: <lock module> <home> <rounds> <id>.
 * Everything is files in <home>: the parent writes `go-<r>` and `done-<r>`, this process writes `ready-<id>`,
 * `res-<r>-<id>` (`WON <pid>` or `LOST <why>`) and `released-<r>-<id>`.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [modulePath, home, roundsText, id] = process.argv.slice(2) as [string, string, string, string];
const { acquireServeLock } = (await import(modulePath)) as typeof import("../src/startup/s3-serve-lock");

const waitFor = (file: string): void => {
  while (!existsSync(file)) {
    // A tight spin keeps the two children within microseconds of each other once `go` appears.
  }
};

writeFileSync(join(home, `ready-${id}`), "1");
for (let round = 0; round < Number(roundsText); round++) {
  waitFor(join(home, `go-${round}`));
  let held: { release(): void } | undefined;
  let result: string;
  try {
    held = acquireServeLock({ home });
    result = `WON ${process.pid}`;
  } catch (error) {
    result = `LOST ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`;
  }
  writeFileSync(join(home, `res-${round}-${id}`), result);
  waitFor(join(home, `done-${round}`));
  held?.release();
  writeFileSync(join(home, `released-${round}-${id}`), "1");
}
