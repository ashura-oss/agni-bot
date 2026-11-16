/**
 * The mock provider as a function, so a test can start one in-process on a
 * free port, and `index.ts` can start one from the command line.
 *
 * Two behaviours, chosen by whether a script is given:
 *
 *   no script   every chat request is echoed back as a short streamed reply
 *               (the keyless way to run bench, failover and streaming checks);
 *   a script    requests that carry tools play the next scripted step: some
 *               text, tool calls, or both. This is a "hijacked model": the
 *               script does what hostile text told it to do, and the product
 *               has to contain it. Requests without tools (summaries,
 *               compaction) get a short canned reply and do not consume the
 *               script.
 */

export interface MockToolCall {
  name: string;
  args: unknown;
  id?: string;
}

export interface MockStep {
  /** Streamed content; an array is one delta per entry. */
  text?: string | string[];
  calls?: MockToolCall[];
  usage?: { in: number; out: number };
}

export interface MockProviderOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Answer every chat request with 429 (a failover fixture). */
  fail?: boolean;
  /** Pause between streamed chunks. */
  delayMs?: number;
  model?: string;
  script?: MockStep[];
}

export interface RecordedRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  tools: unknown[];
}

export interface MockProvider {
  /** `http://127.0.0.1:<port>/v1`, the provider's base URL. */
  url: string;
  port: number;
  /** Chat requests that carried tools, in order. */
  readonly requests: RecordedRequest[];
  /** Scripted steps not yet played. */
  remaining(): number;
  stop(): void;
}

const encoder = new TextEncoder();

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const delayMs = options.delayMs ?? 5;
  const model = options.model ?? "mock-model";
  const script = options.script ? [...options.script] : null;
  const requests: RecordedRequest[] = [];
  let callCounter = 0;

  const sleep = (ms: number): Promise<void> => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

  function scriptedStream(step: MockStep): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const deltas = typeof step.text === "string" ? [step.text] : step.text ?? [];
        for (const delta of deltas) {
          controller.enqueue(sse({ choices: [{ delta: { content: delta } }] }));
          await sleep(delayMs);
        }
        if (step.calls?.length) {
          controller.enqueue(sse({
            choices: [{
              delta: {
                tool_calls: step.calls.map((spec, index) => ({
                  index,
                  id: spec.id ?? `mock_call_${++callCounter}`,
                  type: "function",
                  function: { name: spec.name, arguments: JSON.stringify(spec.args) },
                })),
              },
            }],
          }));
        }
        controller.enqueue(sse({
          choices: [{ delta: {}, finish_reason: step.calls?.length ? "tool_calls" : "stop" }],
          ...(step.usage ? { usage: { prompt_tokens: step.usage.in, completion_tokens: step.usage.out } } : {}),
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  function echoStream(lastUser: string): ReadableStream<Uint8Array> {
    const words = `mock(${model}): ${lastUser || "no input"}`.split(" ");
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        await sleep(delayMs);
        for (const word of words) {
          controller.enqueue(sse({ choices: [{ delta: { content: `${word} ` } }] }));
          await sleep(delayMs);
        }
        controller.enqueue(sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: words.length } }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  let boundPort = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/chat/completions") && request.method === "POST") {
        if (options.fail) {
          return new Response(JSON.stringify({ error: { message: "mock: rate limited" } }), {
            status: 429,
            headers: { "retry-after": "2", "content-type": "application/json" },
          });
        }
        const body = (await request.json().catch(() => ({}))) as {
          messages?: RecordedRequest["messages"];
          tools?: unknown[];
        };
        const headers = { "content-type": "text/event-stream" };
        if (script) {
          if (!body.tools || body.tools.length === 0) return new Response(scriptedStream({ text: "ok" }), { status: 200, headers });
          requests.push({ messages: body.messages ?? [], tools: body.tools });
          const step = script.shift() ?? { text: "(the scripted model has nothing more to say)" };
          return new Response(scriptedStream(step), { status: 200, headers });
        }
        const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
        return new Response(echoStream(typeof lastUser?.content === "string" ? lastUser.content : ""), { status: 200, headers });
      }
      return Response.json({ ok: true, port: boundPort, fail: Boolean(options.fail), model });
    },
  });

  boundPort = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${boundPort}/v1`,
    port: boundPort,
    requests,
    remaining: () => script?.length ?? 0,
    stop: () => { void server.stop(true); },
  };
}
