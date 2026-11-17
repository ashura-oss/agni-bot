import { AttachmentInfoSchema, type AttachmentInfo } from "@agni/client";
import { AppearanceProfileSchema, type AppearanceProfile, type ChannelInfo } from "@agni/protocol";
/**
 * The app model: pairing, the connection, the open transcript, the roster, the
 * daemon's health, and every user intent the views need. Views call methods
 * here; frames arrive here from AgniConnection; nothing else reaches the
 * network. This is the TypeScript port of `AppModel.swift`.
 */
import {
  AgniConnection,
  Conversation,
  SecretStore,
  SettingsStore,
  defaultServerSettings,
  fetchHealth,
  healthURL,
  isKnownFrame,
  isReady,
  pageOrigin,
  websocketURL,
  type AgentInfo,
  type ApprovalRow,
  type ApprovalRuleInfo,
  safeLine,
  type ChatMessage,
  type ClientFrame,
  type ChatGPTConnection,
  type ConnectionEvent,
  type ConnectionState,
  type ConversationEffect,
  type FormRow,
  type FrameTransport,
  type HealthReport,
  type IncomingFrame,
  type JobInfo,
  type MemoryItem,
  type NoticeKind,
  type NoticeRow,
  type PluginInfo,
  type ProviderStatus,
  type SecretRow,
  type SecretStoreKind,
  type ServerSettings,
  type TaskInfo,
  type TaskListInfo,
  type TaskActivityInfo,
  type ThreadInfo,
} from "@agni/client";
import { browserNotifications, type NotificationBridge } from "./notifications";
import { subscribePush, unsubscribePush } from "./push";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";
import { insertStoppedTurns, loadStops, rememberStop } from "./stops";
import { agentForRoute, agentPath, isSettingsSection, parseRoute, resolveRoute, routePath, type Route, type RouteResolution, type SettingsSection } from "./router";
import { APPEARANCE_PENDING_KEY, cacheAppearance, defaultAppearance, loadCachedAppearance, loadPendingAppearance } from "../appearance";

import type { AppModelEnv, AppScreen, AppSnapshot, ExportLink } from "./snapshot";
import { NEW_AGENT_PROMPT, nextNewAgent, seedAgents } from "./roster";

export type { AppModelEnv, AppScreen, AppSnapshot, ExportLink };
export { isPrimaryAgent, nextNewAgent } from "./roster";

/** The product's own name: the tab title before the roster is known. Never a bot's name. */
const APP_TITLE = "Agni";
/** Typing frames: `true` at most this often while typing goes on; `false` after this much quiet. */
const TYPING_REFRESH_MS = 3000;
const TYPING_IDLE_MS = 1000;
/** What a send that finds no connection says, in the composer and on the failed message alike. */
const OFFLINE_REFUSAL = "Not connected. Your draft was kept; send it again once you are reconnected.";

function notice(kind: NoticeKind, title: string, body: string, threadID: string | null = null): NoticeRow {
  return {
    id: `${kind}_${Math.random().toString(36).slice(2)}`,
    kind,
    title,
    body,
    createdAt: new Date(),
    threadID,
  };
}

export class AppModel {
  private readonly listeners = new Set<() => void>();
  private snapshotValue: AppSnapshot;

  private screen: AppScreen = "pairing";
  private connectionState: ConnectionState = { kind: "idle" };
  private settings: ServerSettings;
  private secretKind: SecretStoreKind | null = null;
  private tokenIsStored = false;
  private cookieSession = false;
  private isCheckingServer = false;
  private isPairing = false;
  private pairingError: string | null = null;

  private conversation = new Conversation("ea");
  private threads: ThreadInfo[] = [];
  private agents: AgentInfo[] = seedAgents();
  /** The daemon has sent the real roster; until then the seed row is only a stand-in. */
  private rosterKnown = false;
  private refusal: string | null = null;
  /** Hidden specialists are absent from the sidebar but still addressable. */
  private mentionAgents: AgentInfo[] = seedAgents();
  /** The channel this client is bound to, when it bound itself to an agent. */
  private boundChannelID: string | null = null;
  private unread = new Set<string>();
  private agentStates: Record<string, "idle" | "working" | "waiting" | "blocked"> = {};
  private memories: MemoryItem[] = [];

  private health: HealthReport | null = null;
  private healthError: string | null = null;
  private configuredProviders: ProviderStatus[] = [];
  private plugins: PluginInfo[] = [];
  private jobs: JobInfo[] = [];
  private tasks: TaskInfo[] = [];
  private taskLists: TaskListInfo[] = [];
  private taskActivity: AppSnapshot["taskActivity"] = null;
  private taskView: AppSnapshot["taskView"] = { kind: "today" };
  private pendingAgentRoute: string | null = null;
  /** Where Settings was opened from, so closing it goes back there. */
  private settingsReturn: Route | null = null;
  /** Where the address bar is, as a route. */
  private route: Route = { kind: "root" };
  private settingsSection: SettingsSection | null = null;
  private groups: ChannelInfo[] | null = null;
  /** The daemon has answered `task.list`, so a task it does not list does not exist. */
  private tasksKnown = false;

  private isAddingProvider = false;
  private providerAddError: string | null = null;
  private providerAddSuccess: string | null = null;
  private providerModels: string[] = [];
  private providerModelsError: string | null = null;
  private pendingProviderID: string | null = null;
  private chatgpt: ChatGPTConnection | null = null;
  private chatgptLogin: AppSnapshot["chatgptLogin"] = null;
  private chatgptBusy = false;
  private chatgptError: string | null = null;
  private chatgptPopup: Window | null = null;
  private chatgptStartCancelled = false;

  private isExporting = false;
  private exportedLink: ExportLink | null = null;
  private exportError: string | null = null;

  private isInspectorPresented = false;
  private isDebugPresented = false;
  private isTasksPresented = false;
  private isSettingsPresented = false;
  private isAgentSwitcherPresented = false;
  private isNewChatPresented = false;
  private isSidebarPresented = false;
  private isAgentProfilePresented = false;
  private preferences: Preferences = loadPreferences();
  private pendingAppearance = loadPendingAppearance();
  private appearance: AppearanceProfile = this.pendingAppearance ?? loadCachedAppearance();
  private appearanceSaveStatus: "saved" | "saving" | "pending" | "error" = this.pendingAppearance ? "pending" : "saved";
  private appearanceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private appearanceAckTimer: ReturnType<typeof setTimeout> | null = null;
  private appearanceInFlight: AppearanceProfile | null = null;
  private appearanceProfiles: AppearanceProfile[] = [this.appearance];
  private focusMessageID: string | null = null;
  private searchText = "";
  private focusComposerToken = 0;
  private statusText: string | null = null;
  private toast: NoticeRow | null = null;
  private approvalRules: ApprovalRuleInfo[] | null = null;
  private runRefusals = 0;
  private rejectedDraft: AppSnapshot["rejectedDraft"] = null;
  /** The local echo of the message just sent, so a refusal can take it back. */
  private lastSent: { localID: string; text: string } | null = null;
  /**
   * Cards the owner has answered that the daemon has not yet closed. An `unknown_request`
   * error names no card, so it is only pinned to one when exactly one answer is outstanding.
   */
  private answered = new Set<string>();
  /**
   * Counts connection attempts (one per hello). A card is stamped with the count when it
   * arrives, so after a restart the cards the new process re-sent can be told from the
   * ones left over from the old one.
   */
  private connectionEpoch = 0;
  /** The conversation whose block the history handler already asked the daemon to open. */
  private openAskedFor: string | null = null;
  /** When Stop and a rule revoke were last sent: both can be answered `not_found`, for different reasons. */
  private lastCancelAt = 0;
  private lastRevokeAt = 0;
  /** When a frame last arrived, and the last one before the current connection attempt began. */
  private lastFrameAt = Date.now();
  private outageStart = Date.now();
  private cardEpoch = new Map<string, number>();

  private connection: AgniConnection | null = null;
  private pendingPairing: { settings: ServerSettings; token: string } | null = null;
  private token = "";

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The channel the last `user.typing: true` went to, until `false` is sent; and when. */
  private typingChannel: string | null = null;
  private typingSentAt = 0;
  private started = false;

  private readonly settingsStore: SettingsStore;
  private unsent = new Map<string, { frame: ClientFrame; resolve: () => void }>();
  private tokenQueue: IncomingFrame[] = [];
  private tokenIsFrame = false;
  private tokenTimer: ReturnType<typeof setTimeout> | number | null = null;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly notifier: NotificationBridge;
  private readonly healthFetch: (url: string) => Promise<HealthReport>;
  private readonly makeTransport: (() => FrameTransport) | undefined;
  private readonly healthPollMs: number;

  constructor(env: AppModelEnv = {}) {
    this.settingsStore = env.settingsStore ?? new SettingsStore();
    this.notifier = env.notifier ?? browserNotifications;
    this.healthFetch = env.healthFetch ?? ((url) => fetchHealth(url));
    this.makeTransport = env.makeTransport;
    this.healthPollMs = env.healthPollMs ?? 20_000;
    this.settings = this.settingsStore.load();
    this.applyLocationRoute(false);
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", this.onLocationChange);
      window.addEventListener("pagehide", this.flushSettings);
    }
    const stored = SecretStore.load();
    if (stored) {
      this.token = stored.token;
      this.secretKind = stored.kind;
      this.tokenIsStored = true;
    }
    this.snapshotValue = this.buildSnapshot();
    this.publish();
  }

  // MARK: store plumbing

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppSnapshot => this.snapshotValue;

  private buildSnapshot(): AppSnapshot {
    return {
      screen: this.screen,
      connectionState: this.connectionState,
      settings: this.settings,
      secretKind: this.secretKind,
      tokenIsStored: this.tokenIsStored,
      cookieSession: this.cookieSession,
      isCheckingServer: this.isCheckingServer,
      isPairing: this.isPairing,
      pairingError: this.pairingError,
      conversation: this.conversation,
      threads: this.threads,
      agents: this.agents,
      mentionAgents: this.mentionAgents,
      unread: new Set(this.unread),
      agentStates: { ...this.agentStates },
      memories: this.memories,
      health: this.health,
      healthError: this.healthError,
      configuredProviders: this.configuredProviders,
      plugins: this.plugins,
      jobs: this.jobs,
      tasks: this.tasks,
      taskLists: this.taskLists,
      taskActivity: this.taskActivity,
      taskView: this.taskView,
      isAddingProvider: this.isAddingProvider,
      providerAddError: this.providerAddError,
      providerAddSuccess: this.providerAddSuccess,
      providerModels: this.providerModels,
      providerModelsError: this.providerModelsError,
      chatgpt: this.chatgpt,
      chatgptLogin: this.chatgptLogin,
      chatgptBusy: this.chatgptBusy,
      chatgptError: this.chatgptError,
      isExporting: this.isExporting,
      exportedLink: this.exportedLink,
      exportError: this.exportError,
      isInspectorPresented: this.isInspectorPresented,
      isDebugPresented: this.isDebugPresented,
      isTasksPresented: this.isTasksPresented,
      isSettingsPresented: this.isSettingsPresented,
      settingsSection: this.settingsSection,
      route: this.route,
      notFound: this.notFound(),
      routePending: this.routePending(),
      groups: this.groups,
      routeTaskID: this.route.kind === "task" ? this.route.id : null,
      isAgentSwitcherPresented: this.isAgentSwitcherPresented,
      isNewChatPresented: this.isNewChatPresented,
      isSidebarPresented: this.isSidebarPresented,
      isAgentProfilePresented: this.isAgentProfilePresented,
      preferences: this.preferences,
      appearance: this.appearance,
      appearanceProfiles: this.appearanceProfiles,
      appearanceSaveStatus: this.appearanceSaveStatus,
      focusMessageID: this.focusMessageID,
      searchText: this.searchText,
      focusComposerToken: this.focusComposerToken,
      statusText: this.statusText,
      toast: this.toast,
      approvalRules: this.approvalRules,
      runRefusals: this.runRefusals,
      rejectedDraft: this.rejectedDraft,
    };
  }

  private publish(): void {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener();
    if (typeof document !== "undefined") {
      // The seed bot's placeholder name must not flash in the tab before the roster arrives.
      const groupName = this.route.kind === "group" ? this.groups?.find((group) => group.id === (this.route as { id: string }).id)?.name : undefined;
      document.title = this.notFound() ? `Not found · ${APP_TITLE}` : this.route.kind === "group" ? (groupName ?? APP_TITLE) : this.rosterKnown ? (this.agent?.name ?? APP_TITLE) : APP_TITLE;
    }
  }

  // MARK: lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.notifier.request();
    if (!this.canConnect && pageOrigin()) {
      void this.resumeCookieSession();
      return;
    }
    this.screen = this.canConnect ? "chat" : "pairing";
    if (this.canConnect && typeof window !== "undefined" && window.location.pathname === "/") this.goTo({ kind: "agent", id: this.agent?.id ?? "ea" }, "replace");
    this.publish();
    if (this.canConnect) this.connect();
  }

  /** Served by the daemon: spend a `#code=` from `agni open`, then reuse the session cookie. */
  private async resumeCookieSession(): Promise<void> {
    this.isCheckingServer = true;
    this.publish();
    try {
      const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
      if (code) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        await this.postPairCode(code, this.settings.deviceName).catch((error: unknown) => {
          this.pairingError = error instanceof Error ? error.message : String(error);
        });
      }
      const response = await fetch("/auth/session", { cache: "no-store" });
      const session = (await response.json()) as { paired?: boolean };
      if (session.paired) this.enterCookieSession();
    } catch {
      // No daemon behind this page (static hosting): the token form still works.
    } finally {
      this.isCheckingServer = false;
      this.publish();
    }
  }

  private async postPairCode(code: string, deviceName: string): Promise<void> {
    const response = await fetch("/auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: deviceName }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Pairing failed (${response.status}).`);
    }
  }

  private enterCookieSession(): void {
    this.cookieSession = true;
    this.pairingError = null;
    this.settings = { ...this.settings, url: pageOrigin() ?? this.settings.url };
    this.settingsStore.save(this.settings);
    this.screen = "chat";
    if (typeof window !== "undefined" && window.location.pathname === "/") this.goTo({ kind: "agent", id: this.agent?.id ?? "ea" }, "replace");
    this.connect();
  }

  /** The pairing view's code form. */
  pairWithCode(code: string, device: string): void {
    void (async () => {
      const name = device.trim() || "This Browser";
      this.pairingError = null;
      this.isCheckingServer = true;
      this.publish();
      try {
        await this.postPairCode(code, name);
        this.settings = { ...this.settings, deviceName: name };
        this.enterCookieSession();
      } catch (error) {
        this.pairingError = error instanceof Error ? error.message : String(error);
      } finally {
        this.isCheckingServer = false;
        this.publish();
      }
    })();
  }

  private onLocationChange = (): void => { this.applyLocationRoute(true); };

  /** Read the address bar: back, forward, a reload, or a link opened in this tab. */
  private applyLocationRoute(refresh: boolean): void {
    if (typeof window === "undefined") return;
    const route = parseRoute(window.location.pathname);
    this.route = route;
    this.isTasksPresented = route.kind === "tasks" || route.kind === "task";
    this.isSettingsPresented = route.kind === "settings";
    this.settingsSection = route.kind === "settings" ? route.section : null;
    this.pendingAgentRoute = route.kind === "agent" ? route.id : null;
    // A task address says nothing about the list behind it: keep the view the owner was on.
    if (route.kind === "tasks") this.taskView = route.view;
    else if (route.kind !== "task") this.taskView = { kind: "today" };
    if (route.kind === "tasks" || route.kind === "task") {
      if (refresh) this.refreshTasks();
    } else if (route.kind === "group") {
      if (refresh) this.refreshGroups();
    } else if (this.pendingAgentRoute) {
      this.syncAgentRoute();
    }
    this.publish();
  }

  /** Does the address name something that exists? Says so once the daemon could have said otherwise. */
  private resolution(): RouteResolution {
    return resolveRoute(this.route, {
      rosterKnown: this.rosterKnown,
      agents: [...this.mentionAgents, ...this.agents],
      groups: this.groups,
      tasks: this.tasks,
      tasksKnown: this.tasksKnown,
    });
  }

  private notFound(): AppSnapshot["notFound"] {
    const found = this.resolution();
    return found.kind === "missing" ? { what: found.what, path: found.path } : null;
  }

  /**
   * A bot address the held roster cannot place yet (a fresh load, or a browser that was away past the
   * replay window) shows loading. Falling back to the seed bot's thread would put a message in the wrong chat.
   */
  private routePending(): boolean {
    return this.screen === "chat" && this.route.kind === "agent" && this.resolution().kind === "pending";
  }

  /** Is the open conversation the bot the address names? A message must only go where the address points. */
  private conversationMatchesAddress(): boolean {
    if (this.route.kind !== "agent") return true;
    const named = agentForRoute(this.route.id, [...this.mentionAgents, ...this.agents]);
    return named !== null && named.id === this.conversation.agentID;
  }

  private syncAgentRoute(): void {
    if (!this.pendingAgentRoute) return;
    const agent = agentForRoute(this.pendingAgentRoute, [...this.mentionAgents, ...this.agents]);
    if (!agent) return;
    this.pendingAgentRoute = null;
    this.selectAgent(agent, false);
  }

  /** Move the address bar: a new history entry by default, or replace the current one. */
  private navigatePath(path: string, mode: "push" | "replace" = "push", state: Record<string, unknown> = {}): void {
    if (typeof window === "undefined" || window.location.pathname === path) return;
    if (mode === "replace") window.history.replaceState(state, "", path);
    else window.history.pushState(state, "", path);
  }

  /** Go to a screen: the address and the route move together. */
  private goTo(route: Route, mode: "push" | "replace" = "push", state: Record<string, unknown> = {}): void {
    this.route = route;
    // An address the owner has since left must not pull the page back when a bot of that name appears.
    this.pendingAgentRoute = null;
    this.navigatePath(routePath(route), mode, state);
  }

  get canConnect(): boolean {
    return (this.token.length > 0 || this.cookieSession) && websocketURL(this.settings) !== null;
  }

  get agent(): AgentInfo | null {
    // A hidden specialist reached through `@name` is not in the sidebar but
    // is still the agent this conversation belongs to.
    return (
      this.mentionAgents.find((agent) => agent.id === this.conversation.agentID) ??
      this.agents.find((agent) => agent.id === this.conversation.agentID) ??
      this.agents[0] ??
      null
    );
  }

  get activeThreadTitle(): string | null {
    return this.conversation.title;
  }

  get serverAddress(): string {
    return this.settings.url;
  }

  get tokenForConnectionForm(): string {
    return this.token;
  }

  /** Pairing: keep the token in browser storage, then open the socket. */
  pair(url: string, enteredToken: string, device: string): void {
    void this.performPair(url, enteredToken, device);
  }

  private async performPair(url: string, enteredToken: string, device: string): Promise<void> {
    const name = device.trim().length === 0 ? "This Browser" : device.trim();
    const candidate: ServerSettings = {
      url: url.trim(),
      deviceName: name,
      lastSeq: 0,
    };
    if (!websocketURL(candidate)) {
      this.pairingError =
        "That is not a server address. Try 127.0.0.1:8787, or ws://100.x.x.x:8787/ws for Tailscale.";
      this.publish();
      return;
    }
    const candidateToken = enteredToken.trim();
    if (candidateToken.length === 0) {
      this.pairingError = "A device token is required — mint one with bun run pair.";
      this.publish();
      return;
    }

    this.pairingError = null;
    this.isCheckingServer = true;
    this.publish();
    try {
      const target = healthURL(candidate);
      if (!target) throw new Error("The server address could not be converted to a health URL.");
      const report = await this.healthFetch(target);
      if (!report.ok) throw new Error("The server health check did not return OK.");
      this.pendingPairing = { settings: candidate, token: candidateToken };
      this.isPairing = true;
      this.health = report;
      this.connect(candidate, candidateToken);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.pairingError = `Could not reach Agni at ${candidate.url}. Check that the daemon is running and the address is correct. ${detail}`;
    } finally {
      this.isCheckingServer = false;
      this.publish();
    }
  }

  editConnection(): void {
    this.pairingError = null;
    this.screen = "pairing";
    this.publish();
  }

  cancelConnectionEdit(): void {
    if (!this.tokenIsStored && !this.cookieSession) return;
    this.pendingPairing = null;
    this.isPairing = false;
    this.connection?.stop();
    this.connection = null;
    this.screen = "chat";
    this.connect();
    this.publish();
  }

  forgetDevice(): void {
    this.cancelChatGPTLogin();
    this.chatgpt = null;
    this.chatgptError = null;
    this.disconnect();
    SecretStore.clear();
    if (this.cookieSession) void fetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    this.cookieSession = false;
    this.token = "";
    this.tokenIsStored = false;
    this.secretKind = null;
    this.threads = [];
    this.agents = seedAgents();
    this.rosterKnown = false;
    this.mentionAgents = seedAgents();
    this.conversation = new Conversation("ea");
    this.health = null;
    this.configuredProviders = [];
    this.jobs = [];
    this.tasks = [];
    this.tasksKnown = false;
    this.groups = null;
    this.plugins = [];
    this.settings = { ...this.settings, lastSeq: 0 };
    this.settingsStore.save(this.settings);
    this.screen = "pairing";
    this.publish();
  }

  private connect(targetSettings?: ServerSettings, targetToken?: string): void {
    const settings = { ...(targetSettings ?? this.settings) };
    const token = targetToken ?? this.token;
    if ((token.length === 0 && !this.cookieSession) || !websocketURL(settings)) return;
    this.connection?.stop();
    const next = new AgniConnection({
      settings,
      token,
      ...(this.makeTransport ? { makeTransport: this.makeTransport } : {}),
    });
    next.onEvent = (event) => this.handle(event);
    this.connection = next;
    next.start();
  }

  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.stopHealthPolling();
  }

  retryNow(): void {
    if (!this.connection) {
      this.connect();
      return;
    }
    this.connection.retryNow();
  }

  // MARK: intents

  /** Open (or resolve) the bound conversation surface for an agent. */
  openConversation(agentID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void (async () => {
      await connection.send({ type: "agent.select", agentID }).catch(() => undefined);
      await connection
        .send({ type: "conversation.open", conversationID: "", agentID })
        .catch(() => undefined);
    })();
  }

  /** Re-request the surface's transcript — after reconnect, gap, or on demand. */
  reloadConversation(): void {
    const conversationID = this.conversation.conversationID;
    const connection = this.connection;
    if (!conversationID || !connection || !isReady(this.connectionState)) return;
    void (async () => {
      await connection
        .send({
          type: "conversation.open",
          conversationID,
          agentID: this.conversation.agentID,
        })
        .catch(() => undefined);
      await connection
        .send({ type: "conversation.history", conversationID, limit: 400 })
        .catch(() => undefined);
    })();
  }

  refreshThreadList(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "thread.list", limit: 100 }).catch(() => undefined);
  }

  refreshJobs(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "job.list", limit: 50 }).catch(() => undefined);
  }

  refreshTasks(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "task.list", status: "all", limit: 200 }).catch(() => undefined);
  }

  selectTaskView(view: AppSnapshot["taskView"]): void {
    this.taskView = view;
    this.isTasksPresented = true;
    this.goTo({ kind: "tasks", view });
    if (view.kind === "today" || view.kind === "inbox" || view.kind === "list") this.refreshTasks();
    this.publish();
  }

  createTask(input: { title: string; description?: string; dueAt?: Date; reminderAt?: Date; deadlineAt?: Date; labels?: string[]; repeatRule?: "none" | "daily" | "weekly" | "monthly"; priority?: "low" | "normal" | "high" | "urgent"; listID?: string; parentTaskID?: string; attachmentIDs?: string[] }): void {
    const connection = this.connection;
    const title = input.title.trim();
    if (!connection || !title) return;
    void connection.send({ type: "task.create", title, ...(input.description ? { description: input.description } : {}), ...(input.dueAt ? { dueAt: input.dueAt.toISOString() } : {}), ...(input.reminderAt ? { reminderAt: input.reminderAt.toISOString() } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt.toISOString() } : {}), ...(input.labels ? { labels: input.labels } : {}), ...(input.repeatRule ? { repeatRule: input.repeatRule } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.listID ? { listID: input.listID } : {}), ...(input.parentTaskID ? { parentTaskID: input.parentTaskID } : {}), ...(input.attachmentIDs ? { attachmentIDs: input.attachmentIDs } : {}) }).catch(() => undefined);
  }

  createTaskList(name: string): void {
    const connection = this.connection;
    if (!connection || !name.trim()) return;
    void connection.send({ type: "task.list.create", name: name.trim() }).catch(() => undefined);
  }

  requestTaskActivity(taskID: string): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "task.activity", taskID }).catch(() => undefined);
  }

  refreshPlugins(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "plugin.list" }).catch(() => undefined);
  }

  /**
   * Render the open conversation to a shareable HTML document on the daemon.
   * The daemon does the rendering, so the file is identical no matter which
   * client asked, and the link works for someone who has never run the app.
   */
  exportConversation(): void {
    this.exportedLink = null;
    this.exportError = null;
    const conversationID = this.conversation.conversationID;
    const connection = this.connection;
    if (!conversationID || !connection || !isReady(this.connectionState)) {
      this.exportError = "Open a conversation first — there is nothing to export yet.";
      this.publish();
      return;
    }
    this.isExporting = true;
    this.publish();
    void connection.send({ type: "thread.export", conversationID }).catch((error: unknown) => {
      this.isExporting = false;
      this.exportError = `Could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`;
      this.publish();
    });
  }

  connectPlugin(pluginID: string, account: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection
      .send({ type: "plugin.connect", pluginID, account: account as "agent" | "owner" })
      .catch(() => undefined);
  }

  /**
   * Send a plugin's credentials to the daemon and connect it. The daemon
   * writes them to its own mode-600 plugins.json; this process keeps nothing.
   */
  configurePlugin(
    pluginID: string,
    account: string,
    credentials: {
      user?: string;
      pass?: string;
      key?: string;
      url?: string;
      clientID?: string;
      clientSecret?: string;
    },
  ): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.showToast(notice("info", "Plugin", "Connect to the daemon before connecting a plugin."));
      return;
    }
    void connection
      .send({
        type: "plugin.configure",
        pluginID,
        account: account as "agent" | "owner",
        ...credentials,
      })
      .catch(() => undefined);
  }

  disconnectPlugin(connectionID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "plugin.disconnect", connectionID }).catch(() => undefined);
  }

  updateTask(task: TaskInfo, action: "done" | "reopen" | "snooze" | "cancel", until?: Date): void {
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({
        type: "task.update",
        taskID: task.id,
        action,
        ...(until ? { until: until.toISOString() } : {}),
      })
      .catch(() => undefined);
  }

  editTask(task: TaskInfo, fields: { title?: string; description?: string | null; dueAt?: Date | null; reminderAt?: Date | null; deadlineAt?: Date | null; labels?: string[]; workflowStatus?: "not_started" | "in_progress" | "ai_review"; progressNote?: string | null; repeatRule?: "none" | "daily" | "weekly" | "monthly"; priority?: "low" | "normal" | "high" | "urgent"; listID?: string }): void {
    const connection = this.connection;
    if (!connection) return;
    const { dueAt, reminderAt, deadlineAt, ...rest } = fields;
    void connection.send({ type: "task.update", taskID: task.id, action: "edit", ...rest, ...(dueAt !== undefined ? { dueAt: dueAt?.toISOString() ?? null } : {}), ...(reminderAt !== undefined ? { reminderAt: reminderAt?.toISOString() ?? null } : {}), ...(deadlineAt !== undefined ? { deadlineAt: deadlineAt?.toISOString() ?? null } : {}) }).catch(() => undefined);
  }

  handoffTask(task: TaskInfo, agent: AgentInfo): boolean {
    this.selectAgent(agent);
    const sent = this.send(`Please work on this task for me. Task ID: ${task.id}\nTitle: ${task.title}${task.description ? `\nDetails: ${task.description}` : ""}${task.dueAt ? `\nDue: ${task.dueAt}` : ""}${task.deadlineAt ? `\nDeadline: ${task.deadlineAt}` : ""}${task.labels?.length ? `\nLabels: ${task.labels.join(", ")}` : ""}\nUpdate the task's progressNote as you work so I can see what you are doing, add relevant labels if needed, and move its workflow status to AI review when your work is ready. Tell me what you did and what still needs my review.`);
    if (!sent) {
      // `send` raises no notice of its own; say why here.
      if (this.refusal) this.showToast(notice("failure", "Not sent", this.refusal));
      return false;
    }
    // Only a message that went makes the task "handed off".
    this.editTask(task, { workflowStatus: "in_progress", progressNote: `Handed off to ${agent.name}` });
    return true;
  }

  /**
   * DEL-006: answer a question a delegated task asked. Its own frame, so a
   * normal message can never resume a task by accident.
   */
  answerTask(taskID: string, questionID: string, text: string): void {
    const connection = this.connection;
    const answer = text.trim();
    if (!connection || !answer) return;
    void connection.send({ type: "task.answer", taskID, questionID, text: answer }).catch(() => undefined);
  }

  /** Ask what the agent can remember (PR 8). */
  refreshMemories(scope: "global_user" | "agent" = "global_user"): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "memory.list", scope, limit: 100 }).catch(() => undefined);
  }

  /** Pin this client to an agent's conversation and its DM channel. */
  bindDirect(agentID: string): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "bind.direct", agentID }).catch(() => undefined);
  }

  /** Resolve a leading `@name`/`@id` against the visible roster. */
  private resolveMention(text: string): { agent: AgentInfo; text: string } | null {
    const prefix = /^\s*@/.exec(text);
    if (!prefix) return null;
    const after = text.slice(prefix[0].length);
    const lowered = after.toLowerCase();
    const roster = new Map<string, AgentInfo>();
    for (const agent of [...this.agents, ...this.mentionAgents]) roster.set(agent.id, agent);
    const candidates = [...roster.values()].sort(
      (a, b) => Math.max(b.id.length, b.name.length) - Math.max(a.id.length, a.name.length),
    );
    for (const agent of candidates) {
      for (const name of [agent.id, agent.name]) {
        const needle = name.toLowerCase();
        if (!lowered.startsWith(needle)) continue;
        const boundary = after.slice(needle.length);
        // A mention ends at whitespace or punctuation; `@fridayish` is not a
        // message to Friday.
        if (boundary !== "" && !/^[\s,:;.!?-]/.test(boundary)) continue;
        return { agent, text: boundary.replace(/^[\s,:;.!?-]+/, "").trim() };
      }
    }
    return null;
  }

  /**
   * Why the last `send` answered false, in words for the owner. Whoever called `send` shows it once, where
   * the owner is looking; `send` raises no toast of its own. `null`: the last send went, or there was
   * nothing to send.
   */
  sendRefusal(): string | null {
    return this.refusal;
  }

  send(text: string, attachments: AttachmentInfo[] = []): boolean {
    this.refusal = null;
    if (!this.conversationMatchesAddress()) {
      // No toast: whoever called `send` shows this once, where the owner is looking (see `sendRefusal`).
      this.refusal = "This chat is still loading. Your draft was kept; send it again in a moment.";
      return false;
    }
    const content = text.trim() ? text : (attachments.length ? "Please review the attached files." : "");
    const trimmed = content.trim();
    if (trimmed.length === 0) return false;
    // `@friday write the email` opens Friday's chat and sends there, the way
    // a messaging app treats an address. The server routes it too, but the
    // surface has to follow or the reply would stream into a chat the owner
    // is not looking at.
    const mention = this.resolveMention(trimmed);
    if (mention && mention.agent.id !== this.conversation.agentID) this.selectAgent(mention.agent);
    const outgoing = mention ? mention.text : content;
    if (outgoing.length === 0) {
      // Only an address: the chat is open, there is nothing to say yet.
      this.refusal = `Add a message after @${mention?.agent.name ?? "the name"}. Your draft was kept.`;
      return false;
    }
    const localID = this.conversation.appendLocalUserMessage(outgoing, new Date(), attachments);
    this.lastSent = { localID, text: content };
    this.publish();
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      // One wording, shown by the caller (the composer, or the hand-off toast) and on the failed echo.
      this.refusal = OFFLINE_REFUSAL;
      this.conversation.markLocalFailure(localID, OFFLINE_REFUSAL);
      this.publish();
      return false;
    }
    const specialistID = this.conversation.agentID === "ea" ? undefined : this.conversation.agentID;
    const channelID = this.boundChannelID ?? (specialistID ? `dm:${specialistID}` : "main");
    void connection
      .send({
        type: "msg.send",
        text: outgoing,
        ...(attachments.length ? { files: attachments.map((file) => file.id) } : {}),
        channelId: channelID,
        ...(specialistID ? { toAgentId: specialistID } : {}),
      })
      .catch((error: unknown) => {
        this.conversation.markLocalFailure(
          localID,
          `Send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.publish();
      });
    return true;
  }

  private async attachmentRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const base = healthURL(this.settings);
    if (!base || (!this.token && !this.cookieSession)) throw new Error("Connect to the server first.");
    // Cookie mode: same origin, so the browser sends the session cookie itself.
    const response = await fetch(new URL(path, base), {
      ...init,
      headers: this.token ? { ...init.headers, Authorization: `Bearer ${this.token}` } : init.headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Attachment request failed (${response.status}).`);
    }
    return response;
  }

  async uploadAttachment(file: File): Promise<AttachmentInfo> {
    const body = new FormData();
    body.append("file", file);
    const response = await this.attachmentRequest("/attachments", { method: "POST", body });
    const payload = await response.json() as { attachment: unknown };
    return AttachmentInfoSchema.parse(payload.attachment);
  }

  async uploadTaskAttachment(file: File): Promise<AttachmentInfo> {
    const body = new FormData();
    body.append("file", file);
    body.append("purpose", "task");
    const response = await this.attachmentRequest("/attachments", { method: "POST", body });
    const payload = await response.json() as { attachment: unknown };
    return AttachmentInfoSchema.parse(payload.attachment);
  }

  async removeDraftAttachment(id: string): Promise<void> {
    await this.attachmentRequest(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async attachmentBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.attachmentRequest(`/attachments/${encodeURIComponent(id)}`, { signal })).blob();
  }

  async uploadBackground(file: File): Promise<{ id: string }> {
    const body = new FormData();
    body.append("file", file);
    const response = await this.attachmentRequest("/backgrounds", { method: "POST", body });
    return await response.json() as { id: string };
  }

  async backgroundBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.attachmentRequest(`/backgrounds/${encodeURIComponent(id)}`, { signal })).blob();
  }

  async removeBackground(id: string): Promise<void> {
    await this.attachmentRequest(`/backgrounds/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async sendAttachments(text: string, attachments: AttachmentInfo[], expectedAgentID?: string): Promise<void> {
    await this.attachmentRequest("/attachments/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: attachments.map((file) => file.id) }),
    });
    if (expectedAgentID && this.conversation.agentID !== expectedAgentID) throw new Error("The selected agent changed. Review your draft and send it again.");
    if (!this.send(text, attachments)) throw new Error(this.refusal ?? OFFLINE_REFUSAL);
  }

  renameAgent(name: string, agentID = "ea"): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "agent.rename", agentId: agentID, name }).catch(() => undefined);
  }

  /** Change an agent's tag (what it is for) and how much other agents see. */
  updateAgentProfile(
    agentID: string,
    changes: { role?: string; visibility?: "private" | "summary" | "shared" },
  ): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "agent.profile", agentId: agentID, ...changes }).catch(() => undefined);
  }

  /**
   * Tell the server the owner is typing. Called on every keystroke, so it speaks only when something
   * changes: `true` when typing starts and again at most every 3 s while it goes on, `false` once when
   * it stops (a second of quiet, a cleared field, a send) and never twice in a row.
   */
  updateTypingState(isTyping: boolean): void {
    if (this.typingTimer !== null) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    const connection = this.connection;
    if (!isTyping) {
      const channelID = this.typingChannel;
      this.typingChannel = null;
      // Said `true` to a channel: say `false` to that same channel, even if the bot has changed since.
      if (channelID === null || !connection || !isReady(this.connectionState)) return;
      void connection.send({ type: "user.typing", channelId: channelID, isTyping: false }).catch(() => undefined);
      return;
    }
    if (!connection || !isReady(this.connectionState)) return;
    // The browser-local preference decides whether we tell the server at all.
    if (!this.preferences.typingIndicator) return;
    const channelID = this.conversation.agentID === "ea" ? "main" : `dm:${this.conversation.agentID}`;
    const now = Date.now();
    if (this.typingChannel !== channelID || now - this.typingSentAt >= TYPING_REFRESH_MS) {
      if (this.typingChannel !== null && this.typingChannel !== channelID) {
        void connection.send({ type: "user.typing", channelId: this.typingChannel, isTyping: false }).catch(() => undefined);
      }
      this.typingChannel = channelID;
      this.typingSentAt = now;
      void connection.send({ type: "user.typing", channelId: channelID, isTyping: true }).catch(() => undefined);
    }
    this.typingTimer = setTimeout(() => this.updateTypingState(false), TYPING_IDLE_MS);
  }

  stopTurn(): void {
    const turnID = this.conversation.inFlightTurnID;
    const connection = this.connection;
    if (!turnID || !connection) return;
    this.lastCancelAt = Date.now();
    void connection.send({ type: "msg.cancel", turnID }).catch(() => undefined);
  }

  /**
   * Send an answer and resolve the card only once the send succeeded. A failed
   * send keeps the card pending and queues the frame for the next reconnect
   * (`keep`; secrets are never kept, their value must not outlive the form).
   */
  private reply(requestID: string, frame: ClientFrame, resolve: () => void, keep = true): void {
    const connection = this.connection;
    const failed = (): void => {
      if (keep) this.unsent.set(requestID, { frame, resolve });
      this.showToast(notice("failure", "Not sent", "Reconnecting — your answer is still pending."));
      this.publish();
    };
    if (!connection || !isReady(this.connectionState)) return failed();
    connection.send(frame).then(
      () => {
        this.unsent.delete(requestID);
        this.answered.add(requestID);
        // A stale entry is harmless but should not pile up: keep the latest few.
        for (const old of [...this.answered].slice(0, Math.max(0, this.answered.size - 50))) this.answered.delete(old);
        resolve();
        this.publish();
      },
      failed,
    );
  }

  private flushUnsent(): void {
    for (const [id, { frame, resolve }] of [...this.unsent]) this.reply(id, frame, resolve);
  }

  answer(approval: ApprovalRow, decision: string): void {
    // A card the daemon has closed (answered elsewhere, expired) is gone: nothing to send.
    if (!this.conversation.approvals.some((candidate) => candidate.id === approval.id)) return;
    this.reply(
      approval.id,
      { type: "approve.reply", requestID: approval.id, decision: decision as "once" | "always" | "reject" },
      () => {
        this.conversation.resolveApproval(approval.id, decision);
        // "Always allow" makes a rule: the reply is already on the wire, so the list asked for
        // next comes back with it.
        if (decision === "always") this.refreshApprovalRules();
      },
    );
  }

  /**
   * Answer a question the agent asked. The answer goes back on its own frame
   * so the turn waiting on it can carry on.
   */
  answerForm(form: FormRow, answer: string): void {
    if (!this.conversation.forms.some((candidate) => candidate.id === form.id)) return;
    this.reply(form.id, { type: "form.answer", requestID: form.id, answer }, () =>
      this.conversation.resolveForm(form.id, answer),
    );
  }

  /** Send a one-time secret. The value is never kept in app state or the transcript. */
  submitSecret(secret: SecretRow, value: string): void {
    this.reply(secret.id, { type: "secret.reply", requestID: secret.id, value }, () =>
      this.conversation.resolveSecret(secret.id), false);
  }

  cancelSecret(secret: SecretRow): void {
    this.reply(secret.id, { type: "secret.cancel", requestID: secret.id }, () =>
      this.conversation.resolveSecret(secret.id));
  }

  selectAgent(agent: AgentInfo, updateRoute = true): void {
    // Picking an agent from anywhere — the roster, the switcher, the new-chat
    // field — means the conversation is the surface again.
    this.closeSidebar();
    const leavingSettings = this.isSettingsPresented;
    this.isTasksPresented = false;
    this.isSettingsPresented = false;
    this.settingsSection = null;
    this.settingsReturn = null;
    // Settings is its own history entry: the bot takes its place, so Back does not reopen Settings.
    if (updateRoute) this.goTo({ kind: "agent", id: agent.id }, leavingSettings ? "replace" : "push");
    this.isNewChatPresented = false;
    if (agent.id === this.conversation.agentID && this.conversation.conversationID !== null) {
      this.reloadConversation();
      return;
    }
    // The channel the daemon bound the old conversation to belongs to that bot.
    this.boundChannelID = null;
    this.conversation = new Conversation(agent.id);
    const agentThread = this.threads.find((thread) => thread.agentID === agent.id);
    if (agentThread) this.unread.delete(agentThread.id);
    this.openConversation(agent.id);
    this.focusComposer();
    this.publish();
  }

  /** A notification names a session block; the surface is the agent's conversation. */
  openThreadFromNotification(threadID: string): void {
    const thread = this.threads.find((candidate) => candidate.id === threadID);
    const agent = thread ? this.agents.find((candidate) => candidate.id === thread.agentID) : undefined;
    if (agent) this.selectAgent(agent);
    else this.reloadConversation();
  }

  setRoutine(job: JobInfo, enabled: boolean): void {
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({ type: "job.set", jobID: job.id, action: enabled ? "resume" : "pause" })
      .catch(() => undefined);
  }

  runRoutine(job: JobInfo): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "job.set", jobID: job.id, action: "run" }).catch(() => undefined);
  }

  setRoutineDomains(job: JobInfo, domains: string[]): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "routine.domains.set", jobID: job.id, domains }).catch(() => undefined);
  }

  openTask(_job: JobInfo): void {
    // A task's results land as session blocks inside the agent's one
    // conversation — there is no separate chat window to open.
    this.reloadConversation();
    this.focusComposer();
  }

  deleteTask(job: JobInfo): void {
    const connection = this.connection;
    if (!connection || job.state === "running") return;
    void connection.send({ type: "job.delete", jobID: job.id }).catch(() => undefined);
  }

  addProvider(providerID: string, apiKey: string, model?: string, baseUrl?: string, label?: string): void {
    const key = apiKey.trim();
    if (key.length === 0) {
      this.providerAddError = "Enter an API key.";
      this.publish();
      return;
    }
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerAddError = "Connect to the daemon before adding a provider.";
      this.publish();
      return;
    }
    this.isAddingProvider = true;
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.pendingProviderID = providerID;
    this.publish();
    void connection
      .send({
        type: "provider.add",
        providerID: providerID as "groq" | "cerebras" | "nim" | "gemini" | "openrouter" | "custom",
        apiKey: key,
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(label ? { label } : {}),
      })
      .catch((error: unknown) => {
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.providerAddError = `Could not send the provider key: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  setProviderModel(providerID: string, model: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerAddError = "Connect to the daemon before changing a model.";
      this.publish();
      return;
    }
    this.isAddingProvider = true;
    this.pendingProviderID = providerID;
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.publish();
    void connection
      .send({
        type: "provider.model.set",
        providerID: providerID as "groq" | "cerebras" | "nim" | "gemini" | "openrouter",
        model,
      })
      .catch((error: unknown) => {
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.providerAddError = `Could not update the model: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  loadProviderModels(providerID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerModelsError = "Connect to the daemon to load available models.";
      this.publish();
      return;
    }
    this.providerModels = [];
    this.providerModelsError = null;
    this.publish();
    void connection
      .send({
        type: "provider.models.list",
        providerID,
      })
      .catch((error: unknown) => {
        this.providerModelsError = `Could not request models: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  prepareToAddProvider(): void {
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.pendingProviderID = null;
    this.chatgptError = null;
    this.refreshChatGPT();
    this.publish();
  }

  refreshChatGPT(): void {
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "provider.auth.status", providerID: "chatgpt" }).catch(() => {});
  }

  startChatGPTLogin(accountID?: string): void {
    if (!this.connection || !isReady(this.connectionState)) {
      this.chatgptError = "Connect to Agni before signing in to ChatGPT.";
      this.publish(); return;
    }
    const host = new URL(websocketURL(this.settings)!).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      this.chatgptError = "Open Agni on the same computer as its server to sign in to ChatGPT.";
      this.publish(); return;
    }
    if (this.chatgptBusy || this.chatgpt?.status === "pending") return;
    this.chatgptStartCancelled = false;
    // Open during the user's click so popup blockers do not prevent OAuth.
    this.chatgptPopup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    if (this.chatgptPopup) this.chatgptPopup.opener = null;
    this.chatgptBusy = true; this.chatgptError = null; this.providerAddSuccess = null;
    this.publish();
    void this.connection.send({ type: "provider.auth.start", providerID: "chatgpt", ...(accountID ? { accountID } : {}) }).catch(() => {
      this.chatgptError = "Could not start ChatGPT sign-in. Try again.";
      this.chatgptBusy = false; this.chatgptPopup?.close(); this.chatgptPopup = null; this.publish();
    });
  }

  cancelChatGPTLogin(): void {
    this.chatgptStartCancelled = true;
    if (this.chatgptLogin) void this.connection?.send({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: this.chatgptLogin.loginID }).catch(() => {});
    this.chatgptLogin = null; this.chatgptBusy = false;
    this.chatgptPopup?.close(); this.chatgptPopup = null; this.publish();
  }

  changeChatGPTAccount(accountID: string, disconnect = false): void {
    if (!this.connection || !isReady(this.connectionState) || this.chatgptBusy) return;
    this.chatgptBusy = true; this.chatgptError = null; this.publish();
    void this.connection.send({ type: disconnect ? "provider.auth.disconnect" : "provider.auth.select", providerID: "chatgpt", accountID }).catch(() => {
      this.chatgptBusy = false; this.chatgptError = "Could not update the ChatGPT account. Try again."; this.publish();
    });
  }

  acknowledgeChatGPTPlan(): void {
    const accountID = this.chatgpt?.activeAccountID;
    if (!this.connection || !accountID || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "provider.auth.acknowledge", providerID: "chatgpt", accountID }).catch(() => {
      this.chatgptError = "Could not save your preference. Please try again."; this.publish();
    });
  }

  // MARK: approval rules

  refreshApprovalRules(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "approval.rules.list" }).catch(() => undefined);
  }

  /** Take one "Always allow" rule away; the list shown follows the daemon's answer. */
  revokeApprovalRule(id: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.showToast(notice("failure", "Not revoked", "Reconnect to the daemon first."));
      return;
    }
    this.lastRevokeAt = Date.now();
    void connection.send({ type: "approval.rule.revoke", id }).catch(() => undefined);
  }

  // MARK: chrome

  setSearchText(text: string): void {
    this.searchText = text;
    this.publish();
  }

  focusComposer(): void {
    this.focusComposerToken += 1;
    this.publish();
  }

  dismissToast(): void {
    this.toast = null;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.publish();
  }

  toggleInspector(): void {
    this.isInspectorPresented = !this.isInspectorPresented;
    // The jobs list is only pushed in answer to a request: ask again when the panel opens.
    if (this.isInspectorPresented) this.refreshJobs();
    this.publish();
  }

  toggleDebug(): void {
    this.isDebugPresented = !this.isDebugPresented;
    this.publish();
  }

  /** Read the daemon's owner-only bot debugger data (GET /debug/*). */
  async debugData<T>(path: string, signal?: AbortSignal): Promise<T> {
    return await (await this.attachmentRequest(`/debug/${path}`, { signal })).json() as T;
  }

  /** Show the task/reminder list in place of the roster. */
  toggleTasks(): void {
    this.isTasksPresented = !this.isTasksPresented;
    if (this.isTasksPresented) {
      this.isSidebarPresented = false;
      this.refreshTasks();
      this.goTo({ kind: "tasks", view: this.taskView });
    } else {
      this.goTo({ kind: "agent", id: this.agent?.id ?? "ea" });
    }
    this.publish();
  }

  closeTasks(): void {
    if (!this.isTasksPresented) return;
    this.isTasksPresented = false;
    this.goTo({ kind: "agent", id: this.agent?.id ?? "ea" });
    this.publish();
  }

  /**
   * The Tasks screen opened a task (`id`) or went back to its list (`null`): the address follows.
   * A task opened inside the app adds a marked history entry, and closing it steps back over that
   * entry, so Back never reopens a task that was just closed. A task that came from a link has no
   * such entry behind it: closing replaces the address instead.
   */
  openTaskRoute(id: string | null): void {
    this.isTasksPresented = true;
    if (id) {
      this.goTo({ kind: "task", id }, "push", { agniTask: true });
    } else if (this.route.kind === "task" && typeof window !== "undefined" && (window.history.state as { agniTask?: boolean } | null)?.agniTask === true) {
      // We pushed this entry: step back over it, and the address bar returns to the list by itself.
      this.route = { kind: "tasks", view: this.taskView };
      window.history.back();
    } else {
      this.goTo({ kind: "tasks", view: this.taskView }, "replace");
    }
    this.publish();
  }

  /** Settings is one history entry: Back leaves it, however many sections were visited. */
  openSettings(section: SettingsSection | null = null): void {
    this.settingsReturn = this.route.kind === "settings" || this.route.kind === "not-found" ? null : this.route;
    this.isSettingsPresented = true;
    this.settingsSection = section;
    this.goTo({ kind: "settings", section }, "push", { agniOverlay: "settings" });
    this.publish();
  }

  /** Change section in place; the address changes, the history does not grow. */
  selectSettingsSection(section: SettingsSection): void {
    if (!isSettingsSection(section)) return;
    this.settingsSection = section;
    this.goTo({ kind: "settings", section }, "replace", typeof window !== "undefined" ? (window.history.state ?? {}) : {});
    this.publish();
  }

  closeSettings(): void {
    if (!this.isSettingsPresented) return;
    this.isSettingsPresented = false;
    this.settingsSection = null;
    const cameFrom = this.settingsReturn ?? { kind: "agent" as const, id: this.agent?.id ?? "ea" };
    this.settingsReturn = null;
    if (typeof window !== "undefined" && (window.history.state as { agniOverlay?: string } | null)?.agniOverlay === "settings") {
      // We pushed the Settings entry: step back over it, and the address bar returns by itself.
      this.route = cameFrom;
      window.history.back();
    } else {
      this.goTo(cameFrom, "replace");
    }
    this.publish();
  }

  /** Ask the daemon for its group channels (answered by `channel.list.ok`). */
  refreshGroups(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "channel.list" }).catch(() => undefined);
  }

  /** Open a group channel's page. */
  openGroup(id: string): void {
    this.closeSidebar();
    this.isTasksPresented = false;
    this.isSettingsPresented = false;
    this.isNewChatPresented = false;
    this.goTo({ kind: "group", id });
    this.refreshGroups();
    this.publish();
  }

  openAgentSwitcher(): void {
    this.isNewChatPresented = false;
    this.isAgentSwitcherPresented = true;
    this.publish();
  }

  closeAgentSwitcher(): void {
    this.isAgentSwitcherPresented = false;
    this.publish();
  }

  /**
   * The "To:" line at the top of the chat, opened by the roster's "+": one
   * field that both picks a conversation and makes a new agent.
   */
  openNewChat(): void {
    this.isAgentSwitcherPresented = false;
    this.isSidebarPresented = false;
    this.isNewChatPresented = true;
    this.publish();
  }

  closeNewChat(): void {
    if (!this.isNewChatPresented) return;
    this.isNewChatPresented = false;
    this.publish();
  }

  /** The phone roster drawer. */
  openSidebar(): void {
    this.isSidebarPresented = true;
    this.publish();
  }

  /** The agent's profile panel. */
  openAgentProfile(): void {
    this.isAgentProfilePresented = true;
    this.publish();
  }

  closeAgentProfile(): void {
    if (!this.isAgentProfilePresented) return;
    this.isAgentProfilePresented = false;
    this.publish();
  }

  closeSidebar(): void {
    if (!this.isSidebarPresented) return;
    this.isSidebarPresented = false;
    this.publish();
  }

  /** A preference switch, applied and stored at once. */
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    if (this.preferences[key] === value) return;
    this.preferences = { ...this.preferences, [key]: value };
    savePreferences(this.preferences);
    if (key === "typingIndicator" && !value) this.updateTypingState(false);
    if (key === "push") this.syncPush();
    this.publish();
  }

  /** Opt in/out of Web Push: ask the daemon for its key (answered by `push.vapid`), or drop the subscription. */
  private syncPush(): void {
    const connection = this.connection;
    if (!connection) return;
    if (this.preferences.push) {
      void connection.send({ type: "push.vapid.get" }).catch(() => undefined);
    } else {
      void unsubscribePush()
        .then(async (endpoint) => { if (endpoint) await connection.send({ type: "push.unsubscribe", endpoint }); })
        .catch(() => undefined);
    }
  }

  /** Pin an agent to the top of the roster, or unpin it. */
  toggleFavorite(agentID: string): void {
    const favorites = this.preferences.favorites.includes(agentID)
      ? this.preferences.favorites.filter((id) => id !== agentID)
      : [...this.preferences.favorites, agentID];
    this.setPreference("favorites", favorites);
  }

  /**
   * Make a new agent, the way the roster's "+" button does.
   *
   * Nothing is filled in first: the bot exists the moment you ask for it, as
   * "New bot", and the conversation opens so it can be named afterwards — by
   * telling it in chat (`rename_agent`) or in its profile. The id is asked for
   * here, rather than left to the server's slug, so the header has a real agent
   * to show while the frame is in flight; the roster then arrives from
   * `agents.update` and replaces this stand-in with the daemon's row.
   */
  startNewAgent(): void {
    const connection = this.connection;
    if (!connection) return;
    const { id, name } = nextNewAgent([...this.agents, ...this.mentionAgents]);
    const agent: AgentInfo = { id, name, tools: [] };
    this.agents = [...this.agents, agent];
    this.mentionAgents = [...this.mentionAgents, agent];
    void connection
      .send({
        type: "agent.create",
        id: agent.id,
        name,
        prompt: NEW_AGENT_PROMPT,
      })
      .catch(() => undefined);
    this.selectAgent(agent);
  }

  /** Scroll the transcript to a message (search results). */
  focusMessage(messageID: string): void {
    this.focusMessageID = messageID;
    this.publish();
  }

  clearFocusMessage(): void {
    if (this.focusMessageID === null) return;
    this.focusMessageID = null;
    this.publish();
  }

  // MARK: derived views

  unreadBlocks(agentID: string): boolean {
    return [...this.unread].some((id) => this.threads.find((thread) => thread.id === id)?.agentID === agentID);
  }

  get filteredAgents(): AgentInfo[] {
    const query = this.searchText.trim().toLowerCase();
    if (query.length === 0) return this.agents;
    return this.agents.filter(
      (agent) => agent.name.toLowerCase().includes(query) || (agent.model ?? "").toLowerCase().includes(query),
    );
  }

  get filteredJobs(): JobInfo[] {
    const query = this.searchText.trim().toLowerCase();
    if (query.length === 0) return this.jobs;
    return this.jobs.filter(
      (job) =>
        (job.title ?? "").toLowerCase().includes(query) ||
        job.kind.toLowerCase().includes(query) ||
        job.state.toLowerCase().includes(query),
    );
  }

  // MARK: connection events

  private handle(event: ConnectionEvent): void {
    switch (event.type) {
      case "state": {
        const wasReady = isReady(this.connectionState);
        this.connectionState = event.state;
        if (!isReady(event.state) && this.pendingAppearance) {
          if (this.appearanceAckTimer) clearTimeout(this.appearanceAckTimer);
          this.appearanceInFlight = null;
          this.appearanceSaveStatus = "pending";
        }
        switch (event.state.kind) {
          case "ready": {
            if (this.pendingPairing) {
              const accepted = { ...this.pendingPairing.settings };
              accepted.lastSeq = this.connection?.lastSeq ?? accepted.lastSeq;
              this.settings = accepted;
              this.token = this.pendingPairing.token;
              this.secretKind = SecretStore.save(this.pendingPairing.token);
              this.tokenIsStored = true;
              this.settingsStore.save(this.settings);
              this.pendingPairing = null;
              this.isPairing = false;
              this.screen = "chat";
            }
            this.refreshThreadList();
            this.refreshJobs();
            this.refreshTasks();
            this.refreshGroups();
            this.refreshPlugins();
            this.refreshAppearance();
            if (this.preferences.push) this.syncPush();
            this.startHealthPolling();
            if (!wasReady) this.openConversation(this.conversation.agentID);
            this.flushUnsent();
            break;
          }
          case "refused":
            if (this.pendingPairing) {
              this.pairingError = event.state.reason;
              this.pendingPairing = null;
              this.isPairing = false;
            } else {
              this.notifyUser("Agni cannot connect", event.state.reason);
            }
            break;
          case "handshaking":
            this.connectionEpoch += 1;
            this.openAskedFor = null;
            this.outageStart = this.lastFrameAt;
            break;
          case "waiting":
            this.stopHealthPolling();
            break;
          default:
            break;
        }
        this.publish();
        return;
      }

      case "frame":
        this.handleFrame(event.frame);
        return;

      case "malformed":
        this.conversation.note(notice("failure", "Unreadable frame", event.detail));
        this.publish();
        return;

      case "durableReloadRequired": {
        // The roster is not forgotten here. The daemon releases its held frames (the fresh `agents.update`
        // among them) after a 1 s timer, which can be before this event's error frame arrives, and nothing
        // sends the roster twice. A browser that never had one still waits for it: `rosterKnown` is false.
        // The daemon could not replay. Only a restart kills what it was running; a replay log that
        // merely moved on while this browser slept leaves the running turn alive and streaming.
        const deadTurn = this.conversation.inFlightTurnID;
        if (event.restarted) this.resetAfterRestart(deadTurn);
        else void this.confirmRestart(deadTurn, Date.now() - this.outageStart);
        this.conversation.note(
          notice(
            "info",
            "Reloaded history",
            "The daemon could not replay that far back, so this conversation was reloaded from the database.",
          ),
        );
        this.refreshThreadList();
        this.reloadConversation();
        this.publish();
        return;
      }

      case "lastSeq":
        this.settings = { ...this.settings, lastSeq: event.seq };
        this.saveSettingsSoon();
        return;
    }
  }

  /**
   * Did the daemon boot while this browser was away? Its uptime says so: a daemon that has been
   * up longer than the outage never stopped, and its running turns are still running.
   */
  private async confirmRestart(deadTurn: string | null, outageMs: number): Promise<void> {
    const url = healthURL(this.settings);
    if (!url) return;
    try {
      const report = await this.healthFetch(url);
      if (report.uptimeMs + 2000 < outageMs) this.resetAfterRestart(deadTurn);
    } catch {
      // No answer: assume nothing, keep what is on screen.
    }
  }

  /**
   * The daemon behind this view restarted: whatever it was in the middle of is gone with it.
   * Forget the running turn and the cards of the old process; the cards the new one re-sent
   * after this connection's hello are kept. Skipped if a different turn has begun since.
   */
  private resetAfterRestart(deadTurn: string | null): void {
    if (this.conversation.inFlightTurnID !== deadTurn) return;
    const current = new Set([...this.cardEpoch].filter(([, epoch]) => epoch === this.connectionEpoch).map(([id]) => id));
    // Tokens still queued for the next animation frame belong to the turn that just died;
    // applied after the reset they would bring its bubble, and the Stop button, back.
    if (this.tokenTimer !== null) {
      if (this.tokenIsFrame) cancelAnimationFrame(this.tokenTimer as number);
      else clearTimeout(this.tokenTimer as ReturnType<typeof setTimeout>);
      this.tokenTimer = null;
    }
    this.tokenQueue = [];
    // "Working" and "waiting" were the old process's word; it sends no presence on connect.
    this.agentStates = {};
    this.conversation.resetLive({ keepCards: current });
    for (const id of [...this.cardEpoch.keys()]) if (!current.has(id)) this.cardEpoch.delete(id);
    this.publish();
  }

  private activeChannel(): string {
    return this.conversation.agentID === "ea" ? "main" : `dm:${this.conversation.agentID}`;
  }

  private saveSettingsSoon(): void {
    if (this.settingsTimer !== null) return;
    this.settingsTimer = setTimeout(() => this.flushSettings(), 1000);
  }

  /** Also called on pagehide so a reload resumes from the real lastSeq. */
  flushSettings = (): void => {
    if (this.settingsTimer === null) return;
    clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    this.settingsStore.save(this.settings);
  };

  /** Apply every queued token in one pass: one publish per frame of animation. */
  flushTokens = (): void => {
    if (this.tokenTimer !== null) {
      if (this.tokenIsFrame) cancelAnimationFrame(this.tokenTimer as number);
      else clearTimeout(this.tokenTimer as ReturnType<typeof setTimeout>);
      this.tokenTimer = null;
    }
    const queue = this.tokenQueue;
    if (queue.length === 0) return;
    this.tokenQueue = [];
    for (const frame of queue) this.run(this.conversation.apply(frame));
    this.publish();
  };

  private handleFrame(frame: IncomingFrame): void {
    this.lastFrameAt = Date.now();
    // A frame type this build does not know is data, not an instruction.
    if (!isKnownFrame(frame)) return;

    if (frame.type === "token") {
      this.tokenQueue.push(frame);
      if (this.tokenTimer === null) {
        this.tokenIsFrame = typeof requestAnimationFrame === "function";
        this.tokenTimer = this.tokenIsFrame
          ? requestAnimationFrame(this.flushTokens)
          : setTimeout(this.flushTokens, 16);
      }
      return;
    }
    this.flushTokens(); // keep order: tokens before whatever arrived after them

    // AppModel owns channel routing; the reducer owns the transcript.
    if (frame.type === "status.update") {
      if (frame.channelId === this.activeChannel()) {
        this.statusText = frame.transient ? frame.text : null;
        this.publish();
      }
      return;
    }

    if (frame.type === "msg.new") {
      // The agent's own channel, or the one the daemon bound this chat to (a routine posts into either).
      if ((frame.channelId !== this.activeChannel() && frame.channelId !== this.boundChannelID) || frame.internal) return;
      this.statusText = null;
      this.run(this.conversation.apply(frame));
      this.publish();
      return;
    }

    if (frame.type === "push.vapid") {
      const connection = this.connection;
      void subscribePush(frame.publicKey)
        .then((json) => {
          if (json?.endpoint && json.keys?.p256dh && json.keys.auth && connection) {
            return connection.send({ type: "push.subscribe", subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } });
          }
          // Blocked or unsupported: the switch must not lie.
          this.setPreference("push", false);
        })
        .catch(() => this.setPreference("push", false));
      return;
    }

    if (frame.type === "agent.updated") {
      const rename = (agent: AgentInfo): AgentInfo =>
        agent.id === frame.agentId
          ? {
              ...agent,
              name: frame.displayName,
              onboarded: frame.onboarded,
              role: frame.role ?? agent.role,
              visibility: frame.visibility ?? agent.visibility,
            }
          : agent;
      this.agents = this.agents.map(rename);
      this.mentionAgents = this.mentionAgents.map(rename);
      this.conversation.apply(frame);
      this.publish();
      return;
    }

    if (frame.type === "thread.list.ok") {
      this.threads = [...frame.threads].sort((a, b) => {
        if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
      this.publish();
      return;
    }

    if (frame.type === "conversation.ok") {
      // A reply for the agent the owner has already navigated away from must
      // not drag the surface back: the frames carry no request id, so the
      // agent they name is what tells a live reply from a stale one.
      if (frame.agentID !== this.conversation.agentID) return;
      const freshSurface = this.conversation.conversationID !== frame.conversationID;
      // This answer is to the open the history handler asked for (to learn the session block):
      // the history it follows is already on screen, so asking for it again would loop for as
      // long as the conversation has no block.
      const answersHistoryOpen = !freshSurface && this.openAskedFor === frame.conversationID;
      if (freshSurface) {
        this.openAskedFor = null;
        this.conversation.bind(
          frame.conversationID,
          frame.agentID,
          frame.sessionID.length === 0 ? null : frame.sessionID,
        );
      } else if (frame.sessionID.length > 0) {
        this.conversation.startSession(frame.sessionID, frame.conversationID);
      }
      const connection = this.connection;
      if (connection && isReady(this.connectionState) && !answersHistoryOpen) {
        void connection
          .send({ type: "conversation.history", conversationID: frame.conversationID, limit: 400 })
          .catch(() => undefined);
      }
      this.publish();
      return;
    }

    if (frame.type === "thread.export.ok") {
      this.isExporting = false;
      this.exportError = null;
      this.exportedLink = { url: frame.url, token: frame.token, records: frame.records };
      this.publish();
      return;
    }

    if (frame.type === "conversation.history.ok") {
      // Same seam: a transcript for a conversation the owner has left is not
      // the one on screen.
      if (frame.conversationID !== this.conversation.conversationID) return;
      this.conversation.loadConversationHistory(
        frame.conversationID,
        this.conversation.agentID,
        frame.messages,
        // A turn running right now (added to the frame by newer daemons; absent from older ones).
        (frame as { runningTurn?: { turnID: string; threadID: string; agentID: string } }).runningTurn ?? null,
      );
      // History does not say how a turn ended; put back the "didn't finish" marks this browser saw.
      const stops = loadStops();
      this.conversation.restoreStops(stops);
      // A reply stopped before any text has no history row to re-mark: put its marker back.
      this.conversation.messages = insertStoppedTurns(this.conversation.messages, stops);
      if (this.conversation.threadID === null && this.openAskedFor !== frame.conversationID) {
        const connection = this.connection;
        if (connection && isReady(this.connectionState)) {
          this.openAskedFor = frame.conversationID;
          void connection
            .send({
              type: "conversation.open",
              conversationID: frame.conversationID,
              agentID: this.conversation.agentID,
            })
            .catch(() => undefined);
        }
      }
      this.publish();
      return;
    }

    if (frame.type === "approval.rules.list.ok") {
      this.approvalRules = frame.rules;
      this.publish();
      return;
    }

    if (frame.type === "approval.rule.revoke.ok") {
      this.approvalRules = (this.approvalRules ?? []).filter((rule) => rule.id !== frame.id);
      this.publish();
      return;
    }

    if (frame.type === "job.list.ok") {
      this.jobs = frame.jobs;
      this.publish();
      return;
    }

    if (frame.type === "channel.list.ok") {
      this.groups = frame.channels;
      this.publish();
      return;
    }

    if (frame.type === "channel.created") {
      this.groups = [...(this.groups ?? []).filter((group) => group.id !== frame.channel.id), frame.channel];
      this.publish();
      return;
    }

    if (frame.type === "task.list.ok") {
      this.tasksKnown = true;
      this.tasks = frame.tasks;
      this.taskLists = frame.lists ?? this.taskLists;
      this.publish();
      return;
    }

    if (frame.type === "task.create.ok") {
      this.tasks = [frame.task, ...this.tasks.filter((task) => task.id !== frame.task.id)];
      this.publish();
      this.refreshTasks();
      return;
    }

    if (frame.type === "task.list.create.ok") {
      this.taskLists = frame.lists;
      this.publish();
      return;
    }

    if (frame.type === "task.activity.ok") {
      this.taskActivity = { taskID: frame.taskID, entries: frame.activity };
      this.publish();
      return;
    }

    if (frame.type === "memory.list.ok") {
      this.memories = frame.memories;
      this.publish();
      return;
    }

    if (frame.type === "task.update.ok") {
      const index = this.tasks.findIndex((task) => task.id === frame.task.id);
      if (index === -1) this.tasks = [...this.tasks, frame.task];
      else this.tasks = this.tasks.map((task) => (task.id === frame.task.id ? frame.task : task));
      this.publish();
      this.refreshTasks();
      return;
    }

    if (frame.type === "provider.auth.started") {
      if (this.chatgptStartCancelled) {
        void this.connection?.send({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: frame.loginID }).catch(() => {});
        return;
      }
      try {
        const url = new URL(frame.authorizeURL);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.searchParams.has("id_token_hint")) throw new Error("Unexpected sign-in URL");
        this.chatgptLogin = { loginID: frame.loginID, authorizeURL: url.href, expiresAt: frame.expiresAt };
        if (this.chatgptPopup && !this.chatgptPopup.closed) this.chatgptPopup.location.replace(url.href);
      } catch {
        // A blocked popup still leaves a visible, validated sign-in link.
        if (!this.chatgptLogin) this.chatgptError = "The ChatGPT sign-in link could not be verified. Try again.";
      }
      this.chatgptBusy = false;
      this.publish(); return;
    }

    if (frame.type === "provider.auth.state") {
      const wasConnecting = !!this.chatgptLogin || this.chatgptBusy;
      this.chatgpt = frame.connection;
      if (frame.connection.status !== "pending") {
        this.chatgptBusy = false; this.chatgptLogin = null; this.chatgptPopup = null;
        if (wasConnecting && frame.connection.status === "connected" && !frame.connection.message) this.providerAddSuccess = "ChatGPT is connected. You're ready to chat.";
        void this.refreshHealth();
      }
      this.publish(); return;
    }

    if (frame.type === "provider.add.ok") {
      this.configuredProviders = frame.providers.map((provider) => {
        const maybeTiers = (provider as { tiers?: string[] }).tiers;
        return {
          id: provider.id,
          label: provider.label,
          model: provider.model,
          tiers: maybeTiers ?? [],
          available: provider.available,
          cooldownRemainingMs: Math.trunc(provider.cooldownRemainingMs),
          ...(provider.lastError !== undefined ? { lastError: provider.lastError } : {}),
          ...(provider.lastSuccessAt !== undefined ? { lastSuccessAt: provider.lastSuccessAt } : {}),
        };
      });
      if (this.health) this.health = { ...this.health, providers: this.configuredProviders };
      const added = frame.providers.find((provider) => provider.id === this.pendingProviderID);
      this.providerAddSuccess = `${added?.label ?? "Provider"} is configured with ${
        added?.model ?? "the selected model"
      }.`;
      this.providerAddError = null;
      this.isAddingProvider = false;
      this.pendingProviderID = null;
      this.publish();
      return;
    }

    if (frame.type === "provider.models.ok") {
      this.providerModels = frame.models;
      this.providerModelsError = null;
      this.publish();
      return;
    }

    if (frame.type === "plugin.list.ok" || frame.type === "plugin.state") {
      this.plugins = frame.plugins;
      this.publish();
      return;
    }

    if (frame.type === "appearance.list.ok" || frame.type === "appearance.updated") {
      this.appearanceProfiles = frame.profiles;
      const remote = frame.profiles.find((profile) => profile.id === frame.activeID) ?? frame.profiles[0] ?? defaultAppearance();
      const matches = (profile: AppearanceProfile | null) => profile && JSON.stringify(profile) === JSON.stringify(remote);
      if (matches(this.pendingAppearance)) {
        this.pendingAppearance = null;
        this.appearanceInFlight = null;
        if (this.appearanceAckTimer) clearTimeout(this.appearanceAckTimer);
        try { localStorage.removeItem(APPEARANCE_PENDING_KEY); } catch { /* storage blocked */ }
        this.appearanceSaveStatus = "saved";
      } else if (matches(this.appearanceInFlight)) {
        this.appearanceInFlight = null;
        if (this.appearanceAckTimer) clearTimeout(this.appearanceAckTimer);
        if (this.pendingAppearance && !this.appearanceSaveTimer) this.retryAppearanceSave();
      }
      this.appearance = this.pendingAppearance ?? remote;
      cacheAppearance(this.appearance);
      this.publish();
      return;
    }

    if (frame.type === "plugin.connect.ok") {
      if (frame.authorizeURL && typeof window !== "undefined") {
        window.open(frame.authorizeURL, "_blank", "noopener,noreferrer");
      }
      this.publish();
      return;
    }

    if (frame.type === "hello.ok") return;

    if (frame.type === "error") {
      if (
        frame.code === "not_running" ||
        (frame.code === "not_found" && this.lastCancelAt > this.lastRevokeAt && Date.now() - this.lastCancelAt < 10_000)
      ) {
        // Stop pressed just as the turn finished: there was nothing left to stop. Not an error.
        this.lastCancelAt = 0;
        this.conversation.finishTurnLocally();
        this.reloadConversation();
        this.publish();
        return;
      }
      if (frame.code === "not_found") {
        // A rule that was already revoked (here or on another device): show what is true now.
        this.showToast(notice("info", "Already gone", frame.message));
        this.refreshApprovalRules();
        return;
      }
      if (frame.code === "already_running") {
        this.runRefusals += 1;
        // The daemon names the job by id; the owner knows it by what it does.
        const named = this.jobs.reduce((text, job) => (job.title ? text.split(job.id).join(`“${job.title}”`) : text), frame.message);
        this.showToast(notice("info", "Already running", named));
        return;
      }
      if (frame.code === "unknown_request") {
        // The card was answered elsewhere or timed out: it is gone, not an error to puzzle over.
        // The error may name the card; otherwise it is only safe to close one when it is the
        // single answer still waiting. With two in flight, closing a guess could drop a live card.
        const outstanding = [...this.answered];
        const named = outstanding.filter((id) => frame.message.includes(id));
        const id = named.length === 1 ? named[0] : outstanding.length === 1 ? outstanding[0] : undefined;
        if (id) {
          this.answered.delete(id);
          this.unsent.delete(id);
          this.conversation.apply({ type: "approval.closed", seq: frame.seq, requestID: id, kind: "approval", reason: "expired" });
          this.conversation.apply({ type: "approval.closed", seq: frame.seq, requestID: id, kind: "form", reason: "expired" });
          this.conversation.resolveSecret(id);
          this.showToast(notice("info", "Request expired", "That request expired or was already answered."));
        } else {
          this.showToast(notice("info", "Request expired", "A request had expired or was already answered."));
        }
        return;
      }
      if (frame.code === "bad_frame" && /too long/i.test(frame.message) && this.lastSent) {
        // Nothing was stored: take the bubble back and hand the text to the composer.
        const sent = this.lastSent;
        this.lastSent = null;
        this.conversation.discardLocalEcho(sent.localID);
        this.rejectedDraft = { token: (this.rejectedDraft?.token ?? 0) + 1, text: sent.text, message: frame.message };
        this.publish();
        return;
      }
      if (frame.code === "provider_auth") {
        this.chatgptError = frame.message; this.chatgptBusy = false;
        this.isAddingProvider = false; this.pendingProviderID = null;
        this.providerAddError = frame.message;
        this.chatgptPopup?.close(); this.chatgptPopup = null;
        this.publish(); return;
      }
      if (
        this.isAddingProvider &&
        ["unknown_provider", "invalid_key", "provider_exists", "provider_storage"].includes(frame.code)
      ) {
        this.providerAddError = frame.message;
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.publish();
        return;
      }
      if (frame.code === "provider_models") {
        this.providerModelsError = frame.message;
        this.publish();
        return;
      }
      if (
        [
          "unknown_plugin",
          "unknown_connection",
          "plugin_not_configured",
          "plugin_unavailable",
          "plugin_connect_failed",
        ].includes(frame.code)
      ) {
        this.showToast(notice("info", "Plugin", frame.message));
        return;
      }
      if (frame.code === "unknown_conversation") {
        this.conversation.conversationID = null;
        this.openConversation(this.conversation.agentID);
        this.publish();
        return;
      }
      if (frame.code === "export_failed") {
        this.isExporting = false;
        this.exportError = frame.message;
        this.publish();
        return;
      }
    }

    if (frame.type === "agents.update" && frame.mentions) this.mentionAgents = frame.mentions;
    if (frame.type === "approval.request" || frame.type === "form.request" || frame.type === "secret.request") {
      this.cardEpoch.set(frame.requestID, this.connectionEpoch);
    }
    // A card the daemon closed must not have a late answer re-sent for it on reconnect.
    if (frame.type === "approval.closed") {
      this.unsent.delete(frame.requestID);
      this.answered.delete(frame.requestID);
    }
    if (frame.type === "turn.end" && frame.stopReason !== "end" && frame.stopReason !== "needs_input") {
      rememberStop(frame.turnID, frame.stopReason);
    }
    const effects = this.conversation.apply(frame);
    if (frame.type === "turn.end" || frame.type === "turn.start") this.refreshThreadList();
    if ((frame.type === "turn.end" || frame.type === "notify") && this.isInspectorPresented) this.refreshJobs();
    this.run(effects);
    this.syncAgentRoute();
    this.publish();
  }

  private run(effects: ConversationEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "refreshThreadList":
          this.refreshThreadList();
          break;
        case "reloadDurableState":
          this.refreshThreadList();
          this.reloadConversation();
          break;
        case "notify":
          this.notifyUser(this.attentionTitle(effect), effect.body, effect.sound, effect.threadID);
          break;
        case "focusComposer":
          this.focusComposer();
          break;
        case "unread":
          if (effect.threadID !== this.conversation.threadID) this.unread.add(effect.threadID);
          break;
        case "agentsChanged":
          this.rosterKnown = true;
          if (JSON.stringify(effect.agents) !== JSON.stringify(this.agents)) this.agents = effect.agents;
          break;
        case "taskChanged":
          this.tasks = this.tasks.map((task) => (task.id === effect.task.id ? effect.task : task));
          break;
        case "bound":
          // The server resolved the agent's conversation and channel; the
          // client follows it from here.
          this.conversation.bind(effect.conversationID, effect.agentID, effect.sessionID || null);
          this.boundChannelID = effect.channelID;
          break;
        case "agentPresence":
          // What the agent is doing: the owner can tell "working" from
          // "waiting for you" without asking.
          this.agentStates = { ...this.agentStates, [effect.agentID]: effect.state };
          break;
        case "presence":
          break;
      }
    }
  }

  // MARK: health

  private startHealthPolling(): void {
    this.stopHealthPolling();
    if (this.healthPollMs <= 0) return;
    void this.refreshHealth();
    this.healthTimer = setInterval(() => void this.refreshHealth(), this.healthPollMs);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  async refreshHealth(): Promise<void> {
    const url = healthURL(this.settings);
    if (!url) return;
    try {
      const report = await this.healthFetch(url);
      this.health = report;
      this.configuredProviders = report.providers;
      this.healthError = null;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  async refreshSettingsData(): Promise<void> {
    await this.refreshHealth();
    this.refreshJobs();
    this.refreshTasks();
    this.refreshMemories();
    this.refreshPlugins();
    this.refreshChatGPT();
    this.refreshAppearance();
    this.refreshApprovalRules();
  }

  refreshAppearance(): void {
    if (!this.connection || !isReady(this.connectionState)) return;
    if (this.pendingAppearance) this.retryAppearanceSave();
    else void this.connection.send({ type: "appearance.list" }).catch(() => undefined);
  }

  retryAppearanceSave(): void {
    if (this.appearanceSaveTimer) clearTimeout(this.appearanceSaveTimer);
    this.appearanceSaveTimer = null;
    const next = this.pendingAppearance;
    if (!next || this.appearanceInFlight) return;
    if (!this.connection || !isReady(this.connectionState)) {
      this.appearanceSaveStatus = "pending"; this.publish(); return;
    }
    this.appearanceInFlight = next;
    this.appearanceSaveStatus = "saving";
    this.publish();
    const failed = () => {
      if (this.appearanceInFlight !== next) return;
      this.appearanceInFlight = null;
      if (this.appearanceAckTimer) clearTimeout(this.appearanceAckTimer);
      this.appearanceSaveStatus = "error"; this.publish();
    };
    this.appearanceAckTimer = setTimeout(failed, 8000);
    void this.connection.send({ type: "appearance.save", profile: next, activate: true }).catch(failed);
  }

  saveAppearance(profile: AppearanceProfile): void {
    const timestamp = Math.max(Date.now(), Date.parse(this.appearance.updatedAt) + 1);
    const next = AppearanceProfileSchema.parse({ ...profile, id: this.appearance.id, name: this.appearance.name, updatedAt: new Date(timestamp).toISOString() });
    this.appearance = next;
    this.pendingAppearance = next;
    this.appearanceProfiles = [next];
    cacheAppearance(next);
    try { localStorage.setItem(APPEARANCE_PENDING_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    if (this.appearanceSaveTimer) clearTimeout(this.appearanceSaveTimer);
    this.appearanceSaveStatus = this.connection && isReady(this.connectionState) ? "saving" : "pending";
    this.publish();
    this.appearanceSaveTimer = setTimeout(() => {
      this.appearanceSaveTimer = null;
      this.retryAppearanceSave();
    }, 400);
  }

  activateAppearance(id: string): void {
    const profile = this.appearanceProfiles.find((item) => item.id === id);
    if (!profile) return;
    this.appearance = profile;
    cacheAppearance(profile);
    this.publish();
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.activate", id }).catch(() => undefined);
  }

  deleteAppearance(id: string): void {
    if (this.appearanceProfiles.length <= 1) return;
    this.appearanceProfiles = this.appearanceProfiles.filter((item) => item.id !== id);
    if (this.appearance.id === id) this.appearance = this.appearanceProfiles[0] ?? defaultAppearance();
    cacheAppearance(this.appearance);
    this.publish();
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.delete", id }).catch(() => undefined);
  }

  // MARK: notifications

  /**
   * The bot behind a card. The frames name none, so a card replayed after a reload falls back
   * to the one bot the daemon says is waiting for the owner, when there is exactly one.
   */
  cardRequesterName(agentID: string | null | undefined): string | null {
    if (agentID) return this.requesterName(agentID);
    const waiting = Object.entries(this.agentStates).filter(([, state]) => state === "waiting");
    return waiting.length === 1 ? this.requesterName(waiting[0]![0]) : null;
  }

  /** The display name of the bot that asked for something, or null when no bot is known. */
  requesterName(agentID: string | null | undefined): string | null {
    if (!agentID) return null;
    return [...this.mentionAgents, ...this.agents].find((agent) => agent.id === agentID)?.name ?? null;
  }

  /** "<bot> needs your approval", or the neutral wording when the frames named no bot. */
  private attentionTitle(effect: Extract<ConversationEffect, { kind: "notify" }>): string {
    const name = this.requesterName(effect.agentID);
    if (!effect.need || !name) return effect.title;
    switch (effect.need) {
      case "approval":
        return `${name} needs your approval`;
      case "question":
        return `${name} has a question`;
      case "password":
        return `${name} needs your password`;
    }
  }

  private notifyUser(rawTitle: string, rawBody: string, sound = false, threadID?: string): void {
    // A toast or system notification repeats what a bot wrote (a command, a question): show it escaped.
    const title = safeLine(rawTitle, 200);
    const body = safeLine(rawBody, 400);
    this.showToast(notice("info", title, body, threadID ?? null));
    if (!this.preferences.notifications) return;
    this.notifier.post(title, body, sound, threadID, (id) => this.openThreadFromNotification(id));
  }

  private showToast(row: NoticeRow): void {
    this.toast = row;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.publish();
    }, 6000);
    this.publish();
  }
}

export type { ChatMessage };

export { agentForRoute, agentPath };
