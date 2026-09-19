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

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/ashishn2412-lab/deep-research-agent.git
cd deep-research-agent
npm install
npm run dev:demo          # → open the URL Vite prints (usually http://localhost:5173)
```

That runs with no Cloudflare account at all. To use the real model, pick a row:

| Command | Model | What you need first |
|---|---|---|
| `npm run dev:demo` | canned fixtures | nothing |
| `npm run dev:rest` | **real Llama 3.3** | Account ID + Workers AI API token in `.dev.vars` — [steps below](#option-b--real-llama-33-over-the-rest-api-no-subdomain-needed) |
| `npm run dev` | **real Llama 3.3** | `wrangler login` **and** a registered workers.dev subdomain |

> Open the URL Vite prints, not `:8787`. Vite serves the UI and proxies
> `/agents/*` (including the WebSocket) to the Worker. If port 5173 is taken it
> will pick 5174 — that's fine, the proxy target is what matters.

## Working on this repo across machines

This project gets edited from more than one laptop. **Always pull before you
start**, otherwise you will diverge and have to merge:

```bash
git pull --ff-only          # fails loudly instead of creating a surprise merge
```

If that refuses because both sides have commits, rebase your local work on top:

```bash
git pull --rebase
```

Then work, and push when done:

```bash
git add -A && git commit -m "..." && git push
```

`.dev.vars`, `node_modules/`, `dist/` and `.wrangler/` are gitignored, so secrets
and build output never travel with the repo. That also means **each machine needs
its own `.dev.vars`** — cloning does not bring your API token with it.

## Running it

### Offline, no Cloudflare account

Workers AI has no local emulation — even under `wrangler dev` the `AI` binding is
a real call to Cloudflare's network. So there is a demo environment with canned
model and search output for working on the app without an account:

```bash
npm run dev:demo      # → http://localhost:5173
```

Everything real still runs: Durable Objects, SQLite, Workflows, checkpointing,
state sync, streaming. Only the model and search responses are fixtures.

There are two ways to reach the real model. Both run the identical pipeline —
they differ only in how the Worker talks to Workers AI.

### Option A — real Llama 3.3 via the AI binding

```bash
npx wrangler login
npm run dev
```

This needs your account to have a **workers.dev subdomain** registered. Workers AI
has no local emulation, so under `wrangler dev` the `AI` binding opens a *remote*
session against Cloudflare, and that session requires the subdomain. Without it
wrangler exits before serving anything:

```
✘ You need to register a workers.dev subdomain before running the dev command in remote mode.
```

**A workers.dev subdomain is free and does not require buying a domain.** It is
just a name like `yourname.workers.dev`. Register it here:

> Cloudflare dashboard → **Workers & Pages** → **Change** next to *Your subdomain*
> → pick any available name → Save.

Do **not** use the `/workers/onboarding` link wrangler prints — that funnel tries
to sell you a custom domain through Cloudflare Registrar, which is a different
(paid) product and is not needed. If you only see a domain-purchase flow, you are
on the wrong page; go to *Workers & Pages* directly.

### Option B — real Llama 3.3 over the REST API (no subdomain needed)

This path calls `api.cloudflare.com` directly and uses **no `AI` binding at all**,
so wrangler never opens the remote session that requires a subdomain. Use it if
subdomain registration is blocked or you would rather not bother.

**1. Get your Account ID.**

Dashboard → **Workers & Pages**. The **Account ID** is in the right-hand sidebar
(a 32-character hex string). Copy it.

Or from the CLI:

```bash
npx wrangler whoami
```

**2. Create a Workers AI API token.**

The quickest route is the prebuilt template:

> Dashboard → **AI** → **Workers AI** → **Use REST API** →
> **Create a Workers AI API Token** → **Create API Token**

Copy the token immediately — Cloudflare shows it exactly once.

If you build one by hand instead (*My Profile → API Tokens → Create Token →
Create Custom Token*), it needs both of these permissions:

| Type | Resource | Access |
|---|---|---|
| Account | Workers AI | **Read** |
| Account | Workers AI | **Edit** |

**3. Put both in `.dev.vars`** in the project root (this file is gitignored, so
the token is never committed):

```
CF_ACCOUNT_ID=your_32_char_account_id
CF_AI_API_TOKEN=your_token
```

**4. Verify the credentials before starting the app** — this isolates a bad token
from an app bug:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast \
  -H "Authorization: Bearer $CF_AI_API_TOKEN" \
  -d '{"messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
```

Expect `{"result":{"response":"ok"...},"success":true,...}`. A `10000`
authentication error means the token is wrong or lacks the Workers AI
permissions; a `7003` error means the Account ID is wrong.

**5. Run it:**

```bash
npm run dev:rest
```

When both a binding and REST credentials are available, REST wins — it is only
ever set deliberately. **Deployed Workers always use the binding**, so this is a
local-development convenience, not a production path.

### Optional: better search results

Search works with no keys (DuckDuckGo Lite, falling back to the Wikipedia API),
but quality improves a lot with a real search API. Add either to the same
`.dev.vars`:

```
BRAVE_SEARCH_API_KEY=...    # free tier: https://api-dashboard.search.brave.com/
TAVILY_API_KEY=...          # https://tavily.com/
```

### Deploy

```bash
npm run deploy
npx wrangler secret put BRAVE_SEARCH_API_KEY   # optional
```

Note: Workflows and Durable Objects with SQLite storage require a paid Workers
plan. The demo environment does not.

## Troubleshooting

### `You need to register a workers.dev subdomain before running the dev command in remote mode`

The `AI` binding needs a remote session and your account has no workers.dev
subdomain. Either register one (free — see [Option A](#option-a--real-llama-33-via-the-ai-binding))
or switch to [Option B](#option-b--real-llama-33-over-the-rest-api-no-subdomain-needed)
and run `npm run dev:rest`.

Do **not** press `l` for local mode as wrangler suggests. Local mode drops the AI
binding entirely, and the app will tell you so:
`No way to reach Workers AI. Pick one: ...`

### `[vite] ws proxy error: connect ECONNREFUSED 127.0.0.1:8787`

A symptom, not the cause — the Worker process failed to start, so Vite has nothing
to proxy to. Scroll up in the output and fix the first `✘ [ERROR]` from the
`[worker]` side.

### `The directory specified by the "assets.directory" field ... does not exist`

The client has not been built. `npm run dev` and `npm run dev:demo` build it
automatically via a `predev` step, so this only appears if you run
`wrangler dev` directly. Fix with `npm run build`.

### `Port 5173 is in use, trying another one...`

Harmless. Vite moves to 5174 and the proxy target is unchanged. Open the URL it
prints. To reclaim 5173: `lsof -ti:5173 | xargs kill`.

### The UI shows a `DEMO MODE` badge

You are running `npm run dev:demo`. Model and search responses are fixtures. Use
`npm run dev:rest` or `npm run dev` for real output.

### `npm install` fails with a 401 / auth error

Your global npm is pointed at a private registry with an expired token. This repo
ships a project-local `.npmrc` pinning the public registry, which normally fixes
it. If it persists, check `npm config get registry` resolves to
`https://registry.npmjs.org/` inside this directory.

### Research finishes but finds few or no sources

Keyless DuckDuckGo scraping gets rate-limited from datacentre IPs, leaving only
the Wikipedia fallback. Add a `BRAVE_SEARCH_API_KEY` to `.dev.vars`.

## What is verified

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
