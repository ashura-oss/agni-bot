/**
 * What the views read from the model: the snapshot type and the model's
 * environment. Types only; `app-model.ts` builds the snapshot.
 */
import type { AppearanceProfile, ChannelInfo } from "@agni/protocol";
import type {
  AgentInfo,
  ApprovalRuleInfo,
  ChatGPTConnection,
  ConnectionState,
  Conversation,
  FrameTransport,
  HealthReport,
  JobInfo,
  MemoryItem,
  NoticeRow,
  PluginInfo,
  ProviderStatus,
  SecretStoreKind,
  ServerSettings,
  SettingsStore,
  TaskActivityInfo,
  TaskInfo,
  TaskListInfo,
  ThreadInfo,
} from "@agni/client";
import type { NotificationBridge } from "./notifications";
import type { Preferences } from "./preferences";
import type { Route, SettingsSection } from "./router";

export type AppScreen = "pairing" | "chat";

export interface ExportLink {
  url: string;
  token: string;
  records: number;
}

export interface AppSnapshot {
  screen: AppScreen;
  connectionState: ConnectionState;
  settings: ServerSettings;
  secretKind: SecretStoreKind | null;
  tokenIsStored: boolean;
  /** Paired by the daemon's HttpOnly session cookie, not a stored token. */
  cookieSession: boolean;
  isCheckingServer: boolean;
  isPairing: boolean;
  pairingError: string | null;

  conversation: Conversation;
  threads: ThreadInfo[];
  agents: AgentInfo[];
  /** Full roster for `@mention` and handoff links, including hidden agents. */
  mentionAgents: AgentInfo[];
  unread: ReadonlySet<string>;
  /** What each agent is doing: idle, working, waiting, blocked. */
  agentStates: Readonly<Record<string, "idle" | "working" | "waiting" | "blocked">>;
  /** What the agent can remember, filtered the way retrieval filters it. */
  memories: MemoryItem[];

  health: HealthReport | null;
  healthError: string | null;
  configuredProviders: ProviderStatus[];
  plugins: PluginInfo[];
  jobs: JobInfo[];
  tasks: TaskInfo[];
  taskLists: TaskListInfo[];
  taskActivity: { taskID: string; entries: TaskActivityInfo[] } | null;
  taskView: { kind: "today" | "inbox" | "upcoming" | "calendar" | "completed" | "list"; listID?: string };

  isAddingProvider: boolean;
  providerAddError: string | null;
  providerAddSuccess: string | null;
  providerModels: string[];
  providerModelsError: string | null;
  chatgpt: ChatGPTConnection | null;
  chatgptLogin: { loginID: string; authorizeURL: string; expiresAt: string } | null;
  chatgptBusy: boolean;
  chatgptError: string | null;

  isExporting: boolean;
  exportedLink: ExportLink | null;
  exportError: string | null;

  isInspectorPresented: boolean;
  /** The full-screen bot debugger is open. */
  isDebugPresented: boolean;
  /** The left pane is showing the task/reminder list instead of the roster. */
  isTasksPresented: boolean;
  isSettingsPresented: boolean;
  /** The section Settings is on, as the address names it; null means the default one. */
  settingsSection: SettingsSection | null;
  /** The address the page is at, read as a route. */
  route: Route;
  /** Set when the address names something that does not exist; the page keeps its address. */
  notFound: { what: "bot" | "group" | "task" | "page"; path: string } | null;
  /** Group channels; null until the daemon has listed them. */
  groups: ChannelInfo[] | null;
  /** The task an address names, to open on the Tasks screen. */
  routeTaskID: string | null;
  isAgentSwitcherPresented: boolean;
  /** The composer's "To:" list: pick who the chat is with, or make a new agent. */
  isNewChatPresented: boolean;
  /** Phone layout: the agent roster slides in over the conversation. */
  isSidebarPresented: boolean;
  /** The agent's own profile panel, opened from the header pill. */
  isAgentProfilePresented: boolean;
  /** Browser-local preferences: the switches in Settings. */
  preferences: Preferences;
  appearance: AppearanceProfile;
  appearanceProfiles: AppearanceProfile[];
  appearanceSaveStatus: "saved" | "saving" | "pending" | "error";
  /** A message the transcript should scroll to (from search). */
  focusMessageID: string | null;
  searchText: string;
  focusComposerToken: number;
  statusText: string | null;
  toast: NoticeRow | null;
  /** The standing "Always allow" rules; null until the daemon has answered. */
  approvalRules: ApprovalRuleInfo[] | null;
  /** Counts the daemon's "already running" refusals of Run now, so a button can stand down. */
  runRefusals: number;
  /** A message the daemon refused as too long: its text goes back to the composer. */
  rejectedDraft: { token: number; text: string; message: string } | null;
}

export interface AppModelEnv {
  settingsStore?: SettingsStore;
  makeTransport?: () => FrameTransport;
  healthFetch?: (url: string) => Promise<HealthReport>;
  notifier?: NotificationBridge;
  healthPollMs?: number;
}
