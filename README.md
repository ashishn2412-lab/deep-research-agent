# Deep Research Agent

An AI research agent on Cloudflare. Ask a substantive question and it plans
sub-questions, searches the web, reads the pages it finds, discards the junk, and
writes a report where every claim carries a citation. It remembers how you like
answers and applies that to the next report.

The interesting part is not the report — it's that the run is **durable**. A
research pass is ~20 separately checkpointed steps. Restart the Worker halfway
through and the run resumes from the last completed step rather than starting
over.

```
┌──────────────┐   WebSocket    ┌───────────────────────────────┐
│  React SPA   │◄──────────────►│  ResearchAgent                │
│  (Workers    │  state sync    │  (Durable Object + SQLite)     │
│   Assets)    │  + token       │                                │
└──────────────┘    stream      │  • synced state → all clients   │
                                │  • embedded memory (bge-base)   │
                                │  • routes each turn             │
                                └───────┬───────────────▲─────────┘
                                        │ runWorkflow   │ RPC:
                                        │               │ reportProgress
                                        ▼               │ completeResearch
                                ┌───────────────────────┴─────────┐
                                │  ResearchWorkflow               │
                                │  (Cloudflare Workflows)         │
                                │                                 │
                                │  plan → queries → search →      │
                                │  read → triage → synthesize →   │
                                │  persist → learn                │
                                │  each step.do() = a checkpoint  │
                                └────────┬────────────────────────┘
                                         │
                          ┌──────────────┴──────────────┐
                          ▼                             ▼
                  ┌───────────────┐            ┌────────────────┐
                  │  Workers AI   │            │  Search + read │
                  │  Llama 3.3 70B│            │  Brave/Tavily/ │
                  │  bge-base     │            │  DDG/Wikipedia │
                  └───────────────┘            └────────────────┘
```

## Requirement mapping

| Required component | How it is implemented |
|---|---|
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI for routing, planning, query generation, source triage and synthesis. `@cf/baai/bge-base-en-v1.5` for memory embeddings. No third-party model keys. → `src/server/ai.ts`, `src/server/prompts.ts` |
| **Workflow / coordination** | Cloudflare **Workflows** runs the research pipeline as ~20 checkpointed `step.do()` calls, started by the Agent via `this.runWorkflow()` and reporting back over RPC. → `src/server/workflow.ts` |
| **User input via chat** | React SPA served from Workers Assets, connected over a single WebSocket via `useAgent`. Streaming replies for follow-ups. → `src/client/` |
| **Memory / state** | Two layers: Agent **synced state** (durable, fans out to every client on `setState`) and the Durable Object's embedded **SQLite** holding embedded memories, every past report, and every source ever seen. → `src/server/memory.ts` |

## How a turn actually works

1. The browser opens one WebSocket to `/agents/research-agent/<sessionId>`.
   `sessionId` addresses a Durable Object, so a returning user reaches the same
   instance and the same memory. There is no session store.
2. On each message the Agent recalls relevant memories (cosine similarity over
   stored embeddings) and asks Llama 3.3 to classify the turn as **research** or
   **chat**.
3. **chat** → streamed straight from the Durable Object, grounded in the current
   report and memory. Tokens arrive as they are generated.
4. **research** → the Agent starts a Workflow and returns immediately. The
   Workflow plans sub-questions, and for each one generates search queries,
   searches, reads pages with `HTMLRewriter`, then has the model score each
   source and extract findings. Sources scoring below 0.4 are dropped.
5. Every step calls `reportProgress()`, which RPCs back into the Agent, which
   calls `setState()` — so the progress board, sub-question checklist and source
   list update live in every open tab.
6. The finished report is written to SQLite and pushed as a message. A final
   `learn` step extracts anything durable about the user.

Because the UI is a pure function of server state, refreshing the page mid-run
shows the run exactly where it was.

## Running it

Requires Node 20+.

```bash
npm install
```

### Offline, no Cloudflare account

Workers AI has no local emulation — even under `wrangler dev` the `AI` binding is
a real call to Cloudflare's network. So there is a demo environment with canned
model and search output for working on the app without an account:

```bash
npm run dev:demo      # → http://localhost:5173
```

Everything real still runs: Durable Objects, SQLite, Workflows, checkpointing,
state sync, streaming. Only the model and search responses are fixtures.

### For real, with Llama 3.3 — via the AI binding

```bash
npx wrangler login
npm run dev           # → http://localhost:5173
```

This requires your Cloudflare account to have a **workers.dev subdomain**
registered (free, and it does not require buying a domain — Cloudflare dashboard
→ *Workers & Pages* → **Change** next to *Your subdomain*). Workers AI has no
local emulation, so under `wrangler dev` the `AI` binding opens a remote session,
and that session needs the subdomain. Without it wrangler exits with:

```
✘ You need to register a workers.dev subdomain before running the dev command in remote mode.
```

### For real, with Llama 3.3 — via the REST API (no subdomain needed)

If you can't or don't want to register a subdomain, this path talks to
`api.cloudflare.com` directly and needs no `AI` binding at all:

1. Dashboard → **Workers AI** → *Use REST API* → **Create a Workers AI API Token**
   (permissions: `Workers AI - Read` and `Workers AI - Edit`). Copy the token and
   your Account ID.
2. Create `.dev.vars`:
   ```
   CF_ACCOUNT_ID=your_account_id
   CF_AI_API_TOKEN=your_token
   ```
3. Run:
   ```bash
   npm run dev:rest     # → http://localhost:5173
   ```

Same real model, same everything else. When both are configured REST wins, since
it is only ever set deliberately. On deploy the binding is always used.

Search works with no keys (DuckDuckGo Lite, falling back to the Wikipedia API),
but result quality is much better with a key. Optional — create `.dev.vars`:

```
BRAVE_SEARCH_API_KEY=...
TAVILY_API_KEY=...
```

### Deploy

```bash
npm run deploy
npx wrangler secret put BRAVE_SEARCH_API_KEY   # optional
```

Note: Workflows and Durable Objects with SQLite storage require a paid Workers
plan. The demo environment does not.

## What Is verified

Not "it compiles" — these were run against a live `wrangler dev`:

- **Full pipeline**: question → 3 sub-questions → 6 sources → cited report,
  driven over the real WebSocket protocol. Every phase transition observed.
- **Step checkpointing**: the Workflows API reports **19 discrete checkpointed
  steps** for one run (`plan`, `queries:sq-1`, `search:sq-1`, `read:sq-1:1`,
  `triage:sq-1`, … `synthesize`, `persist`, `learn`).
- **Durability under restart**: started a run, killed the Worker process
  mid-flight, restarted it. The Workflow resumed, completed all 19 steps, and
  delivered its report with 6 sources — without the client asking again.
- **Memory persistence**: stated a preference, fully disconnected, reconnected.
  The preference, past reports and transcript were all still there.
- **Streaming**: follow-up turns stream token-by-token over the WebSocket while
  research turns correctly route to the Workflow instead.
- `tsc --noEmit` clean under `strict`, `noUnusedLocals` and `noUnusedParameters`.

## Design decisions worth defending

**Similarity search in JS, not Vectorize.** Memory is scoped to one Durable
Object per user. A few hundred 768-dim vectors compare in well under a
millisecond, and keeping them in the same SQLite database as everything else
means one storage system, no extra binding, and no paid-plan requirement for
memory. Vectorize is the right answer at tens of thousands of vectors per user,
not hundreds.

**Synthesis is not streamed.** Streaming from inside a Workflow step is not
durable — a retry would replay tokens the user already saw and duplicate text.
Synthesis happens in one checkpointed step and the finished report is pushed;
streaming is used for chat turns, where it actually improves the experience and
where there is no durability contract to break.

**A separate triage pass.** It would be cheaper to hand every scraped page
straight to the synthesiser. Scoring sources first and dropping everything below
0.4 is what keeps navigation pages and cookie banners from becoming citations.

**The router is an LLM call.** Keyword rules ("does it end in a question mark?")
misclassify constantly — `I prefer tables, summarise that` is a follow-up, not a
new research question, despite being long and imperative. The demo fixture uses
a heuristic and its failure was visible immediately in testing.

**One `setState` per logical change.** `completeResearch` writes the report,
sources, phase and history in a single call so no client ever renders a frame
where the report exists but the run still looks in progress.

**No `dangerouslySetInnerHTML`.** The Markdown renderer builds React nodes
directly. Model output and scraped page titles reach the DOM as text, so there is
no HTML-injection path from either.

## Limitations

- Report quality is bounded by search quality. Keyless DuckDuckGo scraping gets
  rate-limited from datacentre IPs; the Wikipedia fallback keeps runs from
  returning nothing but narrows the sources. A Brave key changes the output
  substantially.
- Llama 3.3 has a 24k context window, so page text is truncated to 6k characters
  per source and 4k per source at triage.
- No PDF extraction — `HTMLRewriter` handles HTML only, and non-HTML content
  types are skipped.
- Research runs are not cancellable server-side. "Cancel" detaches the UI; the
  Workflow finishes and persists its report anyway.
- Chat history in synced state is capped at 60 messages. Full reports live in
  SQLite and are reachable from the "Past reports" panel.

## Project structure

```
src/
  server/
    index.ts      Worker entry; routeAgentRequest + assets fallback
    agent.ts      ResearchAgent — Durable Object: state, memory, routing
    workflow.ts   ResearchWorkflow — the durable, checkpointed pipeline
    ai.ts         Workers AI: chat, streaming, JSON mode, embeddings, cosine
    prompts.ts    every prompt, in one auditable place
    search.ts     search providers + HTMLRewriter page extraction
    memory.ts     SQLite schema, semantic recall, report storage
    demo.ts       DEMO_MODE fixtures
    env.d.ts      secret bindings wrangler can't infer
  client/
    App.tsx       the whole UI, a function of synced state
    Markdown.tsx  dependency-free Markdown → React renderer
  shared/
    types.ts      types shared across the WebSocket boundary
```

`PROMPTS.md` contains the AI-assisted development prompt history required for
submission.
