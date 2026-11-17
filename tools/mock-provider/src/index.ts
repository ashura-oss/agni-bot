#!/usr/bin/env bun
/**
 * Mock OpenAI-compatible provider — the keyless way to run the P0 proof
 * (bench, failover, streaming) and to exercise CI without real providers.
 *
 *   bun run mock                                  healthy stream on :9911
 *   MOCK_PORT=9912 MOCK_FAIL=1 bun run mock       429s everything (failover fixture)
 *   MOCK_DELAY_MS=50 bun run mock                  adds inter-token latency
 *   MOCK_SCRIPT=episode.json bun run mock          plays a scripted (hijacked) model
 *
 * A script is a JSON array of steps, each `{ "text"?: string | string[],
 * "calls"?: [{ "name": string, "args": object, "id"?: string }],
 * "usage"?: { "in": number, "out": number } }`. Requests that carry tools play
 * one step each, in order; requests without tools get a short canned reply.
 * The server logic is in `server.ts` so tests can start one in-process.
 */
import { readFileSync } from "node:fs";
import { createMockProvider, type MockStep } from "./server";

const port = Number.parseInt(Bun.env.MOCK_PORT ?? "9911", 10);
const shouldFail = Bun.env.MOCK_FAIL === "1";
const delayMs = Number.parseInt(Bun.env.MOCK_DELAY_MS ?? "5", 10);
const model = Bun.env.MOCK_MODEL ?? "mock-model";
const script = Bun.env.MOCK_SCRIPT ? (JSON.parse(readFileSync(Bun.env.MOCK_SCRIPT, "utf8")) as MockStep[]) : undefined;

const provider = createMockProvider({ port, fail: shouldFail, delayMs, model, ...(script ? { script } : {}) });

console.log(`mock provider on ${provider.url} (fail=${shouldFail}, model=${model}${script ? `, script=${script.length} steps` : ""})`);
