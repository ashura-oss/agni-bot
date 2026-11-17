/**
 * The eval proxy: every model call an episode's server makes goes through it.
 *
 * - Spend cap: a call is reserved at its worst case before it is sent and
 *   refused with HTTP 402 when the run's cap has no room (`SpendGuard`).
 * - Key: in live mode the real key lives only here and replaces whatever
 *   Authorization the server sent (the server holds a placeholder). Headers
 *   are never recorded.
 * - Record: one `CallRecord` per call (tokens, cached tokens when reported,
 *   the provider's cost, first-token time, finish reason, tool-call names).
 *
 * Imported from round 5's `proxy.ts`. The request body is passed on as the
 * server built it (model, temperature, limits) except for OpenRouter's
 * `usage: { include: true }`, which makes it report the call's cost.
 */
import { actualCostUsd, priceFor, worstCaseUsd, type SpendGuard, type Ticket } from "./spend";
import type { CallRecord } from "./types";

export interface ProxyOptions {
  /** `https://openrouter.ai`, or a mock provider's `http://127.0.0.1:<port>`. The server's path (`/api/v1/...`) is appended. */
  upstreamBase: string;
  /** The real key. When set it replaces the server's Authorization header. Never logged. */
  upstreamKey?: string;
  guard: SpendGuard;
  /** Ask for the provider's cost on chat calls (default true). */
  requestUsage?: boolean;
}

export interface ProxyHandle {
  /** The base URL to give the server: `http://127.0.0.1:<port>/api/v1`. */
  url: string;
  port: number;
  /** One record per finished, refused or failed call, in the order they ended. */
  calls: CallRecord[];
  stop(): void;
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readUsage(rec: CallRecord, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  if (typeof usage.prompt_tokens === "number") rec.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") rec.completionTokens = usage.completion_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  if (typeof cached === "number") {
    rec.cachedTokens = cached;
    rec.cachedReported = true;
  }
  if (typeof usage.cost === "number") rec.reportedCostUsd = usage.cost;
}

export function startProxy(opts: ProxyOptions): ProxyHandle {
  const calls: CallRecord[] = [];
  const upstreamBase = opts.upstreamBase.replace(/\/+$/, "");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const startMs = Date.now();
      const rec: CallRecord = {
        startedAt: new Date(startMs).toISOString(), startMs, endMs: startMs, path: url.pathname, model: "", hadTools: false, nMessages: 0,
        reqChars: 0, status: 0, blocked: false, aborted: false, firstMs: -1, finish: "", contentLen: 0, reasoningLen: 0, toolNames: [],
        cachedReported: false, chargedUsd: 0,
      };
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      let bodyText = hasBody ? await req.text() : "";
      rec.reqChars = bodyText.length;
      const parsed = bodyText ? safeParse(bodyText) : null;
      const body: Record<string, unknown> | null = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      if (body) {
        rec.model = typeof body.model === "string" ? body.model : "";
        rec.nMessages = Array.isArray(body.messages) ? body.messages.length : 0;
        rec.hadTools = Array.isArray(body.tools) && body.tools.length > 0;
        if (Array.isArray(body.messages) && opts.requestUsage !== false) {
          body.usage = { include: true };
          bodyText = JSON.stringify(body);
        }
      }
      const price = priceFor(rec.model);

      // The cap is checked before anything is sent. A body that is not JSON is priced as a chat call of its size.
      let ticket: Ticket | null = null;
      if (hasBody) {
        const worst = worstCaseUsd(body ?? { messages: bodyText }, price);
        ticket = opts.guard.reserve(worst);
        if (!ticket) {
          rec.blocked = true;
          rec.status = 402;
          rec.endMs = Date.now();
          rec.error = `eval spend cap: $${opts.guard.spentUsd.toFixed(4)} spent of $${opts.guard.capUsd.toFixed(4)}; this call could cost up to $${worst.toFixed(4)}`;
          calls.push(rec);
          return Response.json({ error: { message: rec.error, code: 402 } }, { status: 402 });
        }
      }
      let recorded = false;
      const record = (): void => {
        if (recorded) return;
        recorded = true;
        rec.endMs = Date.now();
        if (ticket) {
          rec.chargedUsd = opts.guard.settle(ticket, actualCostUsd(rec, price));
          ticket = null;
        }
        calls.push(rec);
      };

      let upstream: Response;
      try {
        upstream = await fetch(upstreamBase + url.pathname + url.search, {
          method: req.method,
          headers: {
            "content-type": "application/json",
            authorization: opts.upstreamKey ? `Bearer ${opts.upstreamKey}` : (req.headers.get("authorization") ?? ""),
          },
          body: hasBody ? bodyText : undefined,
          signal: req.signal,
        });
      } catch (error) {
        rec.error = `upstream fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        rec.aborted = req.signal.aborted;
        rec.status = 502;
        record();
        return Response.json({ error: { message: "eval proxy: the upstream call failed" } }, { status: 502 });
      }
      rec.status = upstream.status;
      const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!upstream.ok || !upstream.body || !isStream) {
        const text = await upstream.text().catch(() => "");
        if (upstream.ok) readUsage(rec, safeParse(text)?.usage);
        else rec.error = text.slice(0, 400);
        record();
        return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const parseLine = (line: string): void => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        const chunk = safeParse(payload);
        if (!chunk) return;
        if (chunk.usage) readUsage(rec, chunk.usage);
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) rec.finish = String(choice.finish_reason);
        const delta = choice?.delta;
        if (!delta) return;
        const mark = (): void => {
          if (rec.firstMs < 0) rec.firstMs = Date.now() - startMs;
        };
        if (typeof delta.content === "string" && delta.content.length > 0) {
          rec.contentLen += delta.content.length;
          mark();
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          rec.reasoningLen += reasoning.length;
          mark();
        }
        if (Array.isArray(delta.tool_calls)) {
          mark();
          for (const tc of delta.tool_calls) if (tc?.function?.name) rec.toolNames.push(String(tc.function.name));
        }
      };
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          buffer += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            parseLine(buffer.slice(0, nl).trim());
            buffer = buffer.slice(nl + 1);
          }
        },
        flush() {
          if (buffer.trim()) parseLine(buffer.trim());
          record();
        },
      });
      // A server that gives up mid-stream never reaches flush: record from the abort.
      req.signal.addEventListener("abort", () => {
        if (recorded) return;
        rec.aborted = true;
        record();
      }, { once: true });
      return new Response(upstream.body.pipeThrough(tap), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  const port = server.port!;
  return { url: `http://127.0.0.1:${port}/api/v1`, port, calls, stop: () => { void server.stop(true); } };
}
