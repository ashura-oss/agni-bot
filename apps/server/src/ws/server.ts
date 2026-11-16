import { attachmentRequest } from "../attachments/http";
import { backgroundRequest } from "../appearance/http";
import { debugRequest } from "../debug/http";
/**
 * HTTP + WebSocket entry. Binds to AGNI_HOST only (loopback in dev, the
 * Tailscale interface on bb-1) — nothing listens on the public internet.
 *
 * Routes: GET /health (JSON), GET /ws (WebSocket upgrade), GET /share/<token>
 * (a published thread export), GET /debug/* (owner-only bot debugger data),
 * /auth/* (browser pairing), and the built web app for everything else.
 */
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION, encodeFrame, type ServerFrame, type ServerFrameBody } from "@agni/protocol";
import type { Config } from "../config";
import { readMeta, writeMeta } from "../db";
import { log } from "../log";
import { PluginService } from "../plugins/service";
import type { Router, ProviderStatus } from "../models/router";
import { dayTotals, type DayTotals } from "../stores/usage";
import { purgeExpiredShares } from "../share/document";
import { shareRequest } from "../share/http";
import { dispatch, errorFrame, newSession, resumeQueuedMessages, type DispatchDeps, type Session } from "./dispatch";
import { isDeviceRevoked, requestToken, verifyToken } from "../auth/tokens";
import { authRequest } from "../auth/web";
import { createOriginPolicy, originConfigProblem, parseOriginList } from "../auth/origin";
import { staticPageHeaders } from "./csp";
import { webAppRequest } from "./web-app";
import { FrameLog } from "./frame-log";
import { recoverInterruptedTurns } from "./boot-recovery";
import { cancelAllTurns, cancelTurnsForDevice, clearServerStopping, markServerStopping, runningTurnDeviceIDs, whenNoTurnsRunning } from "./turn-registry";
import { dirname, resolve } from "node:path";
import { ChatGPTAuth } from "../models/chatgpt-auth";
import { PushService } from "../push/web-push";
import { homePath } from "../home";

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  /** Plugin connection state lives here (settings pane snapshots, OAuth). */
  readonly plugins: PluginService | undefined;
  /** Fan out a frame to every authed session (job results, notices). */
  emit(body: ServerFrameBody): ServerFrame;
  /**
   * Stop serving and cancel running turns. Resolves once those turns have
   * finished writing, so it is safe to close the database after awaiting it;
   * a caller that does not await still gets the synchronous stop.
   */
  stop(): Promise<void>;
}

/**
 * `GET /health` answers any origin, so a web client on another origin can tell
 * the daemon is up before it pairs. That is safe only because the answer to a
 * caller who is not paired carries no owner or config data (see `liveness`).
 * The full report also needs `Authorization`, which this header set does not
 * allow cross-origin, so it is only ever read same-origin or by a native client.
 */
const HEALTH_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
} as const;

/** Shape of the full `GET /health`, for a paired device — also what `daemon status` shows. */
export interface HealthReport {
  ok: boolean;
  v: number;
  serverTime: string;
  uptimeMs: number;
  seq: number;
  providers: ProviderStatus[];
  usageToday: DayTotals;
  modelCapacity: { active: number; capacity: number };
}

/** What anyone may learn from `GET /health`: that the server is up, and its protocol version. */
export interface Liveness {
  ok: boolean;
  v: number;
  serverTime: string;
  uptimeMs: number;
}

export function liveness(startedAt: number): Liveness {
  return { ok: true, v: PROTOCOL_VERSION, serverTime: new Date().toISOString(), uptimeMs: Date.now() - startedAt };
}

export function healthReport(db: Database, router: Router, seq: number, startedAt: number): HealthReport {
  return {
    ...liveness(startedAt),
    seq,
    providers: router.status(),
    usageToday: dayTotals(db),
    modelCapacity: router.load(),
  };
}

export function startServer(config: Config, db: Database, router: Router, startedAt = Date.now()): RunningServer {
  const frameLog = new FrameLog(config.frameLogCapacity, (seq) => writeMeta(db, "seq", String(seq)));
  // A fresh database has no persisted counter and starts at 1. After a clean stop the
  // counter is exact (the stop left a marker equal to it), so resume from it and
  // let caught-up clients carry on; after a crash it can trail frames already
  // sent, so resume one interval above it (S1-31).
  const persistedSeq = readMeta(db, "seq");
  if (persistedSeq !== null) {
    const exact = readMeta(db, SEQ_CLEAN_KEY) === persistedSeq;
    if (exact) frameLog.adoptSeq(Number.parseInt(persistedSeq, 10) || 0);
    else frameLog.adoptPersistedSeq(Number.parseInt(persistedSeq, 10) || 0);
  }
  // The marker describes the last stop only: a crash from here on must not look clean.
  db.run("DELETE FROM meta WHERE key = ?", [SEQ_CLEAN_KEY]);

  const sessions = new Map<Bun.ServerWebSocket<Session>, Session>();
  clearServerStopping(db);

  /** A live frame for one connection: held while it waits for its resync replay (H32). */
  const deliver = (socket: Bun.ServerWebSocket<Session>, frame: ServerFrame): void => {
    if (socket.data.held) socket.data.held.push(frame);
    else sendIfOpen(socket, frame);
  };

  const push = new PushService(db, {
    vapidPath: config.dbPath === ":memory:" ? ":memory:" : homePath("push-vapid.json"),
    timeZone: config.timeZone,
  });

  const emit = (body: ServerFrameBody): ServerFrame => {
    const frame = frameLog.next(body);
    const connected = new Set<string>();
    for (const [socket, session] of sessions) {
      if (!session.authed) continue;
      deliver(socket, frame);
      if (session.device) connected.add(session.device.id);
    }
    // A closed app is reached by Web Push; a device with a live socket already saw it.
    if (body.type === "notify") void push.notify(body, connected).catch((error) => log.warn("push notify failed", error));
    return frame;
  };

  // M1: `revoke` runs in another process, so the daemon looks for revoked
  // devices among its open sessions and closes them.
  const revocationSweep = setInterval(() => {
    for (const [socket, session] of sessions) {
      if (!session.authed || !session.device || !isDeviceRevoked(db, session.device.id)) continue;
      session.authed = false;
      socket.close(4003, "revoked");
    }
    // A turn outlives its socket, so revocation has to find it by device, not by connection.
    for (const deviceID of runningTurnDeviceIDs()) {
      if (isDeviceRevoked(db, deviceID)) cancelTurnsForDevice(deviceID);
    }
  }, REVOCATION_SWEEP_MS);

  const plugins = new PluginService({ config, db, emit, pluginsPath: config.pluginsPath });
  plugins.autoConnect();
  const chatgpt = new ChatGPTAuth({
    filePath: config.dbPath === ":memory:" ? null : resolve(dirname(config.dbPath), "chatgpt/accounts.json"),
    onChange: () => {
      const connection = chatgpt.state();
      if (connection.status === "connected" && !connection.message) router.connectionReady("chatgpt");
      emit({ type: "provider.auth.state", providerID: "chatgpt", connection });
    },
  });
  router.setChatGPT(chatgpt);

  // Who may reach this server from a browser: exact origins and exact Host
  // names, not "any loopback". The port is only known after bind (tests bind
  // port 0), so it is read through a variable set once the socket is open.
  let boundPort = config.port;
  const extraOrigins = parseOriginList(Bun.env.AGNI_ALLOWED_ORIGINS);
  const policy = createOriginPolicy({
    host: config.host,
    port: () => boundPort,
    publicOrigin: config.publicOrigin,
    extraOrigins,
  });
  const originProblem = originConfigProblem({ host: config.host, port: config.port, publicOrigin: config.publicOrigin, extraOrigins });
  if (originProblem) log[originProblem.level](originProblem.message);
  // Expired exports are deleted at boot (an in-memory test database has no real share directory).
  if (config.dbPath !== ":memory:") purgeExpiredShares();

  const server = Bun.serve<Session>({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 10 * 1024 * 1024 + 65_536,
    async fetch(request, srv) {
      // DNS rebinding: a page on an attacker's domain that resolves to this
      // machine still addresses it by the attacker's name. Refuse any name
      // this server does not answer to, before any route runs.
      if (!policy.hostAllowed(request.headers.get("host"))) {
        return new Response("forbidden host", { status: 403 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/attachments" || url.pathname.startsWith("/attachments/")) {
        return attachmentRequest(request, db, config.dbPath, router, policy);
      }
      if (url.pathname === "/backgrounds" || url.pathname.startsWith("/backgrounds/")) {
        return backgroundRequest(request, db, config.dbPath, policy);
      }
      if (url.pathname.startsWith("/debug/")) {
        return debugRequest(request, db, router, config, policy);
      }
      if (url.pathname === "/health") {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: HEALTH_CORS });
        }
        // Only a paired device (cookie or bearer token) gets providers, usage and capacity.
        const credential = requestToken(request);
        const paired = credential ? await verifyToken(db, credential) : null;
        return Response.json(paired ? healthReport(db, router, frameLog.seq, startedAt) : liveness(startedAt), {
          headers: { ...HEALTH_CORS, "cache-control": "no-store" },
        });
      }
      if (url.pathname.startsWith("/auth/")) {
        return authRequest(request, db, policy.originAllowed);
      }
      if (url.pathname === "/oauth/callback") {
        return handleOAuthCallback(plugins, url);
      }
      // Exported threads. Tokens are opaque file names, validated by the
      // reader, so this route can never be walked out of the share directory.
      const shared = await shareRequest(request, db, policy);
      if (shared) return shared;
      if (url.pathname === "/ws") {
        // Browsers always send Origin; native clients (Mac, CLI) send none.
        // Refusing foreign origins stops any web page in the owner's browser
        // from driving the socket.
        const origin = request.headers.get("origin");
        if (origin !== null && !policy.originAllowed(origin)) {
          return new Response("forbidden origin", { status: 403 });
        }
        const session = newSession();
        // A paired browser's cookie authenticates the socket; `hello` then needs no token.
        const token = requestToken(request);
        const device = token ? await verifyToken(db, token) : null;
        if (device) session.cookieDevice = { id: device.id, name: device.name };
        // Behind a proxy (tailscale serve) every peer is 127.0.0.1, so a
        // forwarded request or a non-loopback page is never "local".
        session.local = LOOPBACK_IPS.has(srv.requestIP(request)?.address ?? "")
          && !request.headers.has("x-forwarded-for")
          && (origin === null || LOOPBACK_HOSTS.has(new URL(origin).hostname));
        if (srv.upgrade(request, { data: session })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return webAppRequest(url.pathname, undefined, request.headers.get("host") ?? undefined);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        sessions.set(socket, socket.data);
        socket.data.helloTimer = setTimeout(() => {
          if (!socket.data.authed) socket.close(4001, "hello timeout");
        }, config.helloTimeoutMs);
        log.debug(`connection ${socket.data.id} opened (${sessions.size} open)`);
      },
      async message(socket, message) {
        if (typeof message !== "string") return;
        const session = socket.data;
        try {
          await dispatch(
            {
              config,
              db,
              router,
              frameLog,
              emit,
              plugins,
              chatgpt,
              push,
              reply: (body) => {
                const frame = frameLog.next(body, { replay: false });
                deliver(socket, frame);
                return frame;
              },
              send: (frame) => sendIfOpen(socket, frame),
              close: (code, reason) => socket.close(code, reason),
            },
            session,
            message,
          );
        } catch (error) {
          // A throwing handler answers its own connection; it never takes the daemon down.
          log.error(`frame handler failed on ${session.id}`, error);
          sendIfOpen(socket, errorFrame(frameLog, "internal", error instanceof Error ? error.message : String(error)));
        }
      },
      close(socket) {
        const session = socket.data;
        if (session.helloTimer !== undefined) clearTimeout(session.helloTimer);
        if (session.holdTimer !== undefined) clearTimeout(session.holdTimer);
        // A turn belongs to the server: it keeps running after its socket closes
        // (reload, phone lock, network blip) and its frames replay on reconnect.
        sessions.delete(socket);
        log.debug(`connection ${session.id} closed (${sessions.size} open)`);
      },
    },
  });

  // H22: owner messages a previous process accepted but never started. They
  // have no connection; their answers reach every client through `emit`.
  const bootDeps: DispatchDeps = {
    config, db, router, frameLog, emit, plugins, chatgpt,
    reply: (body) => frameLog.next(body, { replay: false }),
    send: () => undefined,
    close: () => undefined,
  };
  boundPort = server.port ?? config.port;
  // S1-03: nothing may stay `running` across a restart; do this before any
  // queued message resumes, or it would glue itself onto the dead turn.
  recoverInterruptedTurns(db, emit);
  const resumed = resumeQueuedMessages(bootDeps);
  if (resumed > 0) log.warn(`resumed ${resumed} owner message(s) a previous process left queued`);

  return {
    port: server.port ?? config.port,
    url: `ws://${config.host}:${server.port ?? config.port}/ws`,
    plugins,
    emit,
    async stop() {
      clearInterval(revocationSweep);
      // Turns outlive their sockets, but not the server: stop them, and forget the
      // sockets, so nothing writes to a connection of a server that is gone.
      markServerStopping(db);
      cancelAllTurns();
      sessions.clear();
      chatgpt.stop();
      server.stop(true);
      frameLog.flush();
      // The cancelled turns write their last rows and frames before the caller closes the database.
      await whenNoTurnsRunning();
      // Every frame is out and the counter is final: mark it exact. A caller that closed the
      // database already gets no marker, which only costs the next boot a reload.
      try {
        frameLog.flush();
        writeMeta(db, SEQ_CLEAN_KEY, String(frameLog.seq));
      } catch {
        // database closed under us
      }
    },
  };
}

/**
 * A turn can outlive its connection, so a late frame for a socket that has
 * closed is normal, not an error: drop it. (The frame is in the log; a
 * reconnect replays it.)
 */
function sendIfOpen(socket: Bun.ServerWebSocket<Session>, frame: ServerFrame): void {
  if (socket.readyState !== 1) return;
  socket.send(encodeFrame(frame));
}

const REVOCATION_SWEEP_MS = 2_000;

/** Meta key a clean stop writes: the final seq, so the next boot knows the persisted one is exact. */
const SEQ_CLEAN_KEY = "seq_clean";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The Google OAuth redirect lands here from the system browser: one static
 * page confirming what happened, while the real state flows through frames
 * (`plugin.state`) into every open client. No scripts, no redirects back.
 */
async function handleOAuthCallback(plugins: PluginService | undefined, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const oauthError = url.searchParams.get("error");
  const title = "Agni · connecting";
  if (!plugins) {
    return staticPage(title, "The plugin service is not running on this server.");
  }
  if (oauthError) {
    return staticPage(title, `Google refused the sign-in (${oauthError}). Nothing was connected — try again from the settings pane.`);
  }
  if (!state || !code) {
    return staticPage(title, "This callback is missing its sign-in context. Connect again from the settings pane.");
  }
  const result = await plugins.completeSignIn(state, code);
  const body =
    result.plugin
      ? `${result.plugin} is connected. You can close this tab — the app updates itself.`
      : `Something went wrong: ${result.error ?? "unknown error"}\nNothing is connected; try again from the settings pane.`;
  return staticPage(title, body);
}

const STATIC_PAGE_STYLE = "body{background:#000;color:#fff;font:15px/1.6 ui-sans-serif,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:24px}p{white-space:pre-line;margin:0}";

function staticPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STATIC_PAGE_STYLE}</style>
</head>
<body><main><p>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></main></body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...staticPageHeaders(STATIC_PAGE_STYLE) } },
  );
}
