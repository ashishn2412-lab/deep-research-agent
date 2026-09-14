/**
 * The whole UI is a function of the Agent's synced state.
 *
 * `useAgent` opens a WebSocket to the Durable Object; `onStateUpdate` fires
 * whenever the server calls `setState()`. There is no fetch/polling code here,
 * and no client-side copy of the research state — refresh the page mid-run and
 * the board reappears exactly where it was, because it lives on the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";

import { Markdown } from "./Markdown";
import {
  initialResearchState,
  type Phase,
  type ResearchState,
  type ServerMessage,
} from "@shared/types";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  planning: "Planning sub-questions",
  searching: "Searching the web",
  reading: "Reading sources",
  synthesizing: "Writing the report",
  done: "Done",
  error: "Error",
};

const PHASE_ORDER: Phase[] = ["planning", "searching", "reading", "synthesizing", "done"];

const EXAMPLES = [
  "Compare Cloudflare Workflows and AWS Step Functions for building AI agents",
  "What are the practical limits of Durable Objects for per-user state?",
  "How do teams evaluate RAG pipelines in production in 2026?",
];

/** Stable per-browser session id — this is the Durable Object's address. */
function useSessionId(): string {
  return useMemo(() => {
    const key = "dra:session";
    const fromUrl = new URLSearchParams(location.search).get("session");
    if (fromUrl) {
      localStorage.setItem(key, fromUrl);
      return fromUrl;
    }
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  }, []);
}

export function App() {
  const sessionId = useSessionId();

  const [state, setState] = useState<ResearchState>(initialResearchState);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);
  const [toast, setToast] = useState<{ level: string; text: string } | null>(null);
  const [draft, setDraft] = useState("");

  const agent = useAgent<ResearchState>({
    agent: "research-agent",
    name: sessionId,
    onStateUpdate: (next) => setState(next),
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return; // SDK-internal frame.
      }

      switch (message.type) {
        case "token":
          setStreaming((current) =>
            current && current.id === message.id
              ? { id: message.id, text: current.text + message.delta }
              : { id: message.id, text: message.delta },
          );
          break;
        case "tokenEnd":
          setStreaming(null);
          break;
        case "toast":
          setToast({ level: message.level, text: message.text });
          break;
      }
    },
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const send = useCallback(
    (payload: unknown) => agent.send(JSON.stringify(payload)),
    [agent],
  );

  const busy =
    state.phase !== "idle" && state.phase !== "done" && state.phase !== "error";

  const submit = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      send({ type: "ask", text: clean });
      setDraft("");
    },
    [busy, send],
  );

  const citationNumbers = useMemo(
    () => new Set(state.sources.map((s) => s.n)),
    [state.sources],
  );

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.messages.length, streaming?.text]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ◈
          </span>
          <div>
            <h1>Deep Research Agent</h1>
            <p className="tagline">
              Llama 3.3 on Workers AI · Workflows · Durable Objects
            </p>
          </div>
        </div>

        <div className="badges">
          {state.demoMode && (
            <span className="badge badge-warn" title="Canned model output; no Workers AI calls">
              DEMO MODE
            </span>
          )}
          <span className={`badge ${connected ? "badge-ok" : "badge-off"}`}>
            <span className="dot" aria-hidden="true" />
            {connected ? "connected" : "reconnecting"}
          </span>
          <button className="ghost" onClick={() => send({ type: "reset" })}>
            New conversation
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="chat-pane">
          <div className="transcript" ref={transcriptRef}>
            {state.messages.length === 0 && !streaming && (
              <div className="empty">
                <h2>Ask a research question.</h2>
                <p>
                  Substantive questions launch a durable Cloudflare Workflow that
                  plans sub-questions, searches, reads sources and writes a cited
                  report. Follow-ups are answered instantly from the report.
                </p>
                <div className="examples">
                  {EXAMPLES.map((example) => (
                    <button key={example} onClick={() => submit(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {state.messages.map((message) => (
              <article
                key={message.id}
                className={`message ${message.role} ${message.kind}`}
              >
                <div className="message-role">
                  {message.role === "user" ? "You" : "Agent"}
                  {message.kind === "report" && (
                    <span className="pill">research report</span>
                  )}
                </div>
                {message.kind === "report" ? (
                  <Markdown text={message.content} citations={citationNumbers} />
                ) : (
                  <Markdown text={message.content} />
                )}
              </article>
            ))}

            {streaming && (
              <article className="message assistant chat">
                <div className="message-role">Agent</div>
                <Markdown text={streaming.text} />
                <span className="cursor" aria-hidden="true" />
              </article>
            )}

            {busy && <RunBanner state={state} />}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit(draft);
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(draft);
                }
              }}
              placeholder={
                busy
                  ? "Research in progress…"
                  : "Ask anything. Shift+Enter for a new line."
              }
              rows={2}
              disabled={busy}
            />
            <button type="submit" disabled={busy || draft.trim() === ""}>
              {busy ? "Working…" : "Send"}
            </button>
          </form>
        </section>

        <aside className="sidebar">
          <RunBoard state={state} />
          <Sources state={state} />
          <MemoryPanel state={state} onForget={(id) => send({ type: "forget", id })} />
          <PastReports
            state={state}
            onLoad={(id) => send({ type: "loadReport", id })}
          />
        </aside>
      </main>

      {toast && <div className={`toast toast-${toast.level}`}>{toast.text}</div>}
    </div>
  );
}

function RunBanner({ state }: { state: ResearchState }) {
  const latest = state.log.at(-1);
  return (
    <div className="run-banner">
      <span className="spinner" aria-hidden="true" />
      <div>
        <strong>{PHASE_LABEL[state.phase]}</strong>
        {latest && <span className="run-banner-note">{latest.text}</span>}
      </div>
    </div>
  );
}

function RunBoard({ state }: { state: ResearchState }) {
  const elapsed =
    state.startedAt !== null
      ? Math.round(((state.finishedAt ?? Date.now()) - state.startedAt) / 1000)
      : null;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Run</h3>
        {state.workflowId && (
          <code className="workflow-id" title="Cloudflare Workflow instance id">
            {state.workflowId.slice(0, 8)}
          </code>
        )}
      </div>

      {state.phase === "idle" && state.plan.length === 0 ? (
        <p className="muted">No run yet.</p>
      ) : (
        <>
          <ol className="phases">
            {PHASE_ORDER.map((phase) => {
              const current = state.phase === phase;
              const passed =
                PHASE_ORDER.indexOf(state.phase) > PHASE_ORDER.indexOf(phase);
              return (
                <li
                  key={phase}
                  className={current ? "current" : passed ? "passed" : ""}
                >
                  {PHASE_LABEL[phase]}
                </li>
              );
            })}
          </ol>

          {state.plan.length > 0 && (
            <ul className="subquestions">
              {state.plan.map((sq) => (
                <li key={sq.id} className={sq.status}>
                  <span className="status-icon" aria-hidden="true">
                    {sq.status === "done"
                      ? "✓"
                      : sq.status === "failed"
                        ? "✕"
                        : sq.status === "running"
                          ? "•"
                          : "○"}
                  </span>
                  <span className="subquestion-text">{sq.text}</span>
                  {sq.sourceCount > 0 && (
                    <span className="count">{sq.sourceCount}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {elapsed !== null && (
            <p className="muted small">
              {state.phase === "done" ? "Completed in" : "Running for"} {elapsed}s
            </p>
          )}

          {state.error && <p className="error">{state.error}</p>}

          {state.log.length > 0 && (
            <details className="log">
              <summary>Activity ({state.log.length})</summary>
              <ul>
                {[...state.log].reverse().map((entry) => (
                  <li key={`${entry.ts}-${entry.text}`}>{entry.text}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Sources({ state }: { state: ResearchState }) {
  if (state.sources.length === 0) return null;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Sources</h3>
        <span className="count">{state.sources.length}</span>
      </div>
      <ol className="sources">
        {state.sources.map((source) => (
          <li key={source.url} id={`source-${source.n}`}>
            <span className="source-n">{source.n}</span>
            <div>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.title || source.url}
              </a>
              <span className="host">{hostOf(source.url)}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MemoryPanel({
  state,
  onForget,
}: {
  state: ResearchState;
  onForget: (id: string) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Memory</h3>
        <span className="count">{state.memories.length}</span>
      </div>
      {state.memories.length === 0 ? (
        <p className="muted">
          Nothing remembered yet. Tell the agent how you like answers — for
          example “always prefer tables to prose” — and it will persist.
        </p>
      ) : (
        <ul className="memories">
          {state.memories.map((memory) => (
            <li key={memory.id}>
              <span className={`kind kind-${memory.kind}`}>{memory.kind}</span>
              <span className="memory-text">{memory.text}</span>
              <button
                className="forget"
                title="Forget this"
                onClick={() => onForget(memory.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PastReports({
  state,
  onLoad,
}: {
  state: ResearchState;
  onLoad: (id: string) => void;
}) {
  if (state.pastReports.length === 0) return null;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Past reports</h3>
        <span className="count">{state.pastReports.length}</span>
      </div>
      <ul className="past-reports">
        {state.pastReports.map((report) => (
          <li key={report.id}>
            <button onClick={() => onLoad(report.id)}>
              <span className="past-question">{report.question}</span>
              <span className="past-date">
                {new Date(report.createdAt).toLocaleDateString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
