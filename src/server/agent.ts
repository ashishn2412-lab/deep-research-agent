/**
 * ResearchAgent — one Durable Object per session.
 *
 * It owns three things:
 *   - **State**: `setState()` writes durably and fans out to every connected
 *     browser over the WebSocket. The React UI is a pure function of this.
 *   - **Memory**: an embedded SQLite database holding embedded memories, every
 *     past report, and every source ever seen (see memory.ts).
 *   - **Coordination**: it routes each turn to either a streaming chat reply or
 *     a durable Workflow run, and receives progress callbacks from that run.
 *
 * Because the object is addressed by session id, a returning user reaches the
 * same instance and the same memory with no external session store.
 */

import { Agent, callable, type Connection, type WSMessage } from "agents";

import { chatStream, chatJSON } from "./ai";
import {
  chatPrompt,
  rememberPrompt,
  rememberSchema,
  routePrompt,
  routeSchema,
} from "./prompts";
import { isDemoMode } from "./demo";
import {
  ensureSchema,
  forgetMemory,
  getReport,
  listMemories,
  listReports,
  recallMemories,
  recordSeenSources,
  saveMemory,
  saveReport,
  type SqlFn,
} from "./memory";
import {
  initialResearchState,
  type ChatMessage,
  type ClientMessage,
  type MemoryItem,
  type ResearchProgress,
  type ResearchState,
  type ServerMessage,
  type Source,
} from "@shared/types";

/** Cap on chat history kept in synced state; full reports live in SQLite. */
const MAX_MESSAGES = 60;
const MAX_LOG_ENTRIES = 40;

export class ResearchAgent extends Agent<Env, ResearchState> {
  initialState: ResearchState = initialResearchState;

  /** `this.sql` as a plain function, so memory.ts stays free of `this`. */
  private get db(): SqlFn {
    return this.sql.bind(this) as SqlFn;
  }

  async onStart(): Promise<void> {
    ensureSchema(this.db);

    // Rehydrate the parts of state derived from SQLite. State survives on its
    // own, but this keeps the two in step after a code update or reset.
    this.patch({
      memories: listMemories(this.db),
      pastReports: listReports(this.db),
      demoMode: isDemoMode(this.env),
    });
  }

  // --- client messages ------------------------------------------------------

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return; // Not our protocol (the SDK handles its own frames).
    }

    switch (parsed.type) {
      case "ask":
        await this.handleAsk(parsed.text);
        break;
      case "reset":
        await this.resetSession();
        break;
      case "forget":
        this.forget(parsed.id);
        break;
      case "loadReport":
        this.loadReport(parsed.id);
        break;
      case "cancel":
        this.patch({
          phase: "idle",
          workflowId: null,
          error: null,
        });
        this.log("Run detached from the UI. The Workflow keeps running server-side.");
        break;
      default:
        this.send(connection, {
          type: "toast",
          level: "error",
          text: "Unknown message type",
        });
    }
  }

  /**
   * A user turn. The LLM decides whether this needs a full research run or a
   * quick grounded reply, then we either start a Workflow or stream an answer.
   */
  private async handleAsk(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    if (this.state.phase !== "idle" && this.state.phase !== "done" && this.state.phase !== "error") {
      this.broadcastToClients({
        type: "toast",
        level: "info",
        text: "A research run is already in progress.",
      });
      return;
    }

    this.appendMessage({ role: "user", content: clean, kind: "chat" });

    // Memory is recalled once per turn and reused by both paths.
    let memories: MemoryItem[] = [];
    try {
      memories = await recallMemories(this.env, this.db, clean);
    } catch (err) {
      console.warn("memory recall failed:", String(err));
    }
    const memoryTexts = memories.map((m) => m.text);

    let mode: "research" | "chat" = "research";
    let question = clean;

    try {
      const routed = await chatJSON<{ mode: string; question: string }>(
        this.env,
        routePrompt(clean, Boolean(this.currentReport()), this.state.question),
        routeSchema,
        { maxTokens: 300 },
      );
      mode = routed.mode === "chat" ? "chat" : "research";
      question = (routed.question ?? clean).trim() || clean;
    } catch (err) {
      console.warn("router failed, defaulting to research:", String(err));
    }

    if (mode === "chat") {
      await this.streamChatReply(clean, memoryTexts);
      return;
    }

    await this.startResearch(question, memoryTexts);
  }

  /** Kick off the durable Workflow that does the actual research. */
  private async startResearch(question: string, memories: string[]): Promise<void> {
    this.patch({
      phase: "planning",
      question,
      plan: [],
      sources: [],
      log: [],
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      workflowId: null,
    });

    this.log(`Researching: ${question}`);
    if (memories.length > 0) {
      this.log(`Applying ${memories.length} remembered preference(s)`);
    }

    try {
      const workflowId = await this.runWorkflow("RESEARCH_WORKFLOW", {
        question,
        memories,
        maxSubQuestions: intVar(this.env.MAX_SUBQUESTIONS, 5),
        maxPagesPerSubQuestion: intVar(this.env.MAX_PAGES_PER_SUBQUESTION, 3),
      });

      this.patch({ workflowId });
      this.log(`Workflow ${workflowId} started`);
    } catch (err) {
      const detail = String(err);
      this.patch({ phase: "error", error: `Could not start research: ${detail}` });
      this.log(`Failed to start Workflow: ${detail}`);
    }
  }

  /** Streaming reply for follow-ups, grounded in the report and memory. */
  private async streamChatReply(text: string, memories: string[]): Promise<void> {
    const id = crypto.randomUUID();
    const report = this.currentReport();
    const history = this.state.messages
      .filter((m) => m.kind === "chat")
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    let full = "";
    try {
      for await (const delta of chatStream(
        this.env,
        chatPrompt(text, report, this.state.question, memories, history),
        { maxTokens: 900 },
      )) {
        full += delta;
        this.broadcastToClients({ type: "token", id, delta });
      }
    } catch (err) {
      full = `I hit an error answering that: ${String(err)}`;
    }

    this.broadcastToClients({ type: "tokenEnd", id });
    this.appendMessage({ role: "assistant", content: full.trim(), kind: "chat" });

    // A follow-up is where users usually reveal preferences worth keeping.
    await this.learnFromExchange(text, full);
  }

  // --- workflow callbacks ---------------------------------------------------

  /** Called by the Workflow via RPC on every `reportProgress()`. */
  async onWorkflowProgress(
    _workflowName: string,
    _workflowId: string,
    progress: unknown,
  ): Promise<void> {
    const update = progress as ResearchProgress;

    switch (update.kind) {
      case "phase":
        this.patch({ phase: update.phase });
        if (update.note) this.log(update.note);
        break;

      case "plan":
        this.patch({ plan: update.plan });
        this.log(`Planned ${update.plan.length} sub-question(s)`);
        break;

      case "subQuestion": {
        const plan = this.state.plan.map((sq) =>
          sq.id === update.id
            ? {
                ...sq,
                status: update.status,
                sourceCount: update.sourceCount ?? sq.sourceCount,
              }
            : sq,
        );
        this.patch({ plan });
        if (update.status === "done") {
          const sq = plan.find((s) => s.id === update.id);
          this.log(`✓ ${sq?.text ?? update.id} — ${update.sourceCount ?? 0} source(s)`);
        }
        break;
      }

      case "sources": {
        const existing = new Set(this.state.sources.map((s) => s.url));
        const added = update.sources.filter((s) => !existing.has(s.url));
        if (added.length > 0) {
          this.patch({ sources: [...this.state.sources, ...added] });
          recordSeenSources(this.db, added);
        }
        break;
      }

      case "note":
        this.log(update.text);
        break;
    }
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    _result?: unknown,
  ): Promise<void> {
    this.log(`Workflow ${workflowId} complete`);
    if (this.state.phase !== "done") {
      this.patch({ phase: "done", finishedAt: Date.now() });
    }
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    this.patch({ phase: "error", error, finishedAt: Date.now() });
    this.log(`Workflow ${workflowId} failed: ${error}`);
  }

  // --- RPC surface used by the Workflow ------------------------------------

  /**
   * Store a finished report and push it to every connected browser.
   * Called over RPC from the Workflow's `persist` step.
   */
  async completeResearch(
    question: string,
    markdown: string,
    sources: Source[],
  ): Promise<void> {
    const saved = saveReport(this.db, question, markdown, sources);

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: markdown,
      kind: "report",
      ts: Date.now(),
    };

    // One setState, so clients never observe a frame with the report present but
    // the run still marked in-progress.
    this.patch({
      phase: "done",
      finishedAt: Date.now(),
      sources,
      messages: [...this.state.messages, message].slice(-MAX_MESSAGES),
      pastReports: [saved, ...this.state.pastReports].slice(0, 20),
      log: [
        ...this.state.log,
        { ts: Date.now(), text: `Report saved with ${sources.length} source(s)` },
      ].slice(-MAX_LOG_ENTRIES),
    });
  }

  /**
   * Extract durable memories from an exchange. Called from the Workflow's
   * `learn` step and after each chat turn.
   */
  async learnFromExchange(userText: string, assistantText: string): Promise<void> {
    try {
      const result = await chatJSON<{
        memories: { kind: string; text: string }[];
      }>(
        this.env,
        rememberPrompt(
          `USER: ${userText}\n\nASSISTANT: ${assistantText.slice(0, 2000)}`,
        ),
        rememberSchema,
        { maxTokens: 400 },
      );

      const added: MemoryItem[] = [];
      for (const candidate of result.memories ?? []) {
        const kind = candidate.kind === "preference" ? "preference" : "fact";
        const item = await saveMemory(this.env, this.db, kind, candidate.text);
        if (item) added.push(item);
      }

      if (added.length > 0) {
        this.patch({ memories: listMemories(this.db) });
        for (const item of added) this.log(`Remembered: ${item.text}`);
      }
    } catch (err) {
      // Memory extraction is best-effort; never fail a run over it.
      console.warn("learnFromExchange failed:", String(err));
    }
  }

  // --- callable from the browser -------------------------------------------

  /** Exposed to the client as `agent.stub.getStoredReport(id)`. */
  @callable()
  getStoredReport(id: string): { question: string; markdown: string } | null {
    const report = getReport(this.db, id);
    return report ? { question: report.question, markdown: report.markdown } : null;
  }

  /** Exposed for the "how much do you remember?" panel. */
  @callable()
  memoryStats(): { memories: number; reports: number; sources: number } {
    const [row] = this.sql<{ memories: number; reports: number; sources: number }>`
      SELECT
        (SELECT COUNT(*) FROM memories)     AS memories,
        (SELECT COUNT(*) FROM reports)      AS reports,
        (SELECT COUNT(*) FROM seen_sources) AS sources
    `;
    return row ?? { memories: 0, reports: 0, sources: 0 };
  }

  // --- helpers --------------------------------------------------------------

  private loadReport(id: string): void {
    const report = getReport(this.db, id);
    if (!report) {
      this.broadcastToClients({
        type: "toast",
        level: "error",
        text: "That report is no longer stored.",
      });
      return;
    }

    this.patch({
      phase: "done",
      question: report.question,
      sources: report.sources,
      plan: [],
      log: [],
    });
    this.appendMessage({
      role: "assistant",
      content: report.markdown,
      kind: "report",
    });
  }

  private async resetSession(): Promise<void> {
    // Clears the conversation but deliberately keeps memories and past reports:
    // that is the whole point of durable memory.
    this.patch({
      ...initialResearchState,
      memories: listMemories(this.db),
      pastReports: listReports(this.db),
      demoMode: isDemoMode(this.env),
    });
  }

  private forget(id: string): void {
    forgetMemory(this.db, id);
    this.patch({ memories: listMemories(this.db) });
  }

  private currentReport(): string | null {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const message = this.state.messages[i];
      if (message.kind === "report") return message.content;
    }
    return null;
  }

  private appendMessage(input: Omit<ChatMessage, "id" | "ts">): void {
    const message: ChatMessage = { ...input, id: crypto.randomUUID(), ts: Date.now() };
    this.patch({
      messages: [...this.state.messages, message].slice(-MAX_MESSAGES),
    });
  }

  private log(text: string): void {
    this.patch({
      log: [...this.state.log, { ts: Date.now(), text }].slice(-MAX_LOG_ENTRIES),
    });
  }

  private patch(partial: Partial<ResearchState>): void {
    this.setState({ ...this.state, ...partial });
  }

  private send(connection: Connection, message: ServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private broadcastToClients(message: ServerMessage): void {
    this.broadcast(JSON.stringify(message));
  }
}

function intVar(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
