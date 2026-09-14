/**
 * Types shared between the Worker (server) and the React client.
 *
 * `ResearchState` is the Agent's synced state: the server calls `setState()` and
 * every connected browser receives it automatically over the WebSocket. That is
 * the whole state-sync layer — there is no REST polling anywhere in this app.
 */

export type Phase =
  | "idle"
  | "planning"
  | "searching"
  | "reading"
  | "synthesizing"
  | "done"
  | "error";

export type SubQuestionStatus = "pending" | "running" | "done" | "failed";

export type SubQuestion = {
  id: string;
  text: string;
  status: SubQuestionStatus;
  /** How many sources this sub-question contributed. */
  sourceCount: number;
};

export type Source = {
  /** Citation number used in the report, e.g. `[3]`. */
  n: number;
  url: string;
  title: string;
  snippet: string;
  /** Which sub-question surfaced this source. */
  subQuestionId: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  /** `report` messages are rendered as full markdown research reports. */
  kind: "chat" | "report";
};

export type MemoryItem = {
  id: string;
  kind: "preference" | "fact";
  text: string;
  createdAt: number;
};

export type PastReport = {
  id: string;
  question: string;
  createdAt: number;
};

export type ResearchState = {
  phase: Phase;
  /** The question currently being researched, if any. */
  question: string | null;
  /** Cloudflare Workflow instance id — proof the run is durable. */
  workflowId: string | null;
  plan: SubQuestion[];
  sources: Source[];
  /** Live activity log for the run, newest last. */
  log: { ts: number; text: string }[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  messages: ChatMessage[];
  /** What the agent has durably learned about this user. */
  memories: MemoryItem[];
  pastReports: PastReport[];
  demoMode: boolean;
};

export const initialResearchState: ResearchState = {
  phase: "idle",
  question: null,
  workflowId: null,
  plan: [],
  sources: [],
  log: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  messages: [],
  memories: [],
  pastReports: [],
  demoMode: false,
};

/** Messages the browser sends to the Agent over the WebSocket. */
export type ClientMessage =
  | { type: "ask"; text: string }
  | { type: "cancel" }
  | { type: "reset" }
  | { type: "forget"; id: string }
  | { type: "loadReport"; id: string };

/** Messages the Agent pushes to the browser outside of state sync. */
export type ServerMessage =
  | { type: "token"; id: string; delta: string }
  | { type: "tokenEnd"; id: string }
  | { type: "toast"; level: "info" | "error"; text: string };

/**
 * Progress payload the Workflow reports back to the Agent. The Agent turns
 * each of these into a `setState()` call, which fans out to every browser.
 */
export type ResearchProgress =
  | { kind: "phase"; phase: Phase; note?: string }
  | { kind: "plan"; plan: SubQuestion[] }
  | { kind: "subQuestion"; id: string; status: SubQuestionStatus; sourceCount?: number }
  | { kind: "sources"; sources: Source[] }
  | { kind: "note"; text: string };

/** Params passed from the Agent into the Workflow. */
export type ResearchWorkflowParams = {
  question: string;
  /** Relevant durable memories, injected so the report matches user taste. */
  memories: string[];
  maxSubQuestions: number;
  maxPagesPerSubQuestion: number;
};
