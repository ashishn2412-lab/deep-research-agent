# Prompt history

The assignment requires submitting the prompt history behind AI-assisted work.
This is that log, kept verbatim and in order.

- **Tool:** Claude Code (CLI), model Opus 5
- **Session date:** 2026-09-14
- **Human prompts to date:** 1 free-text prompt + 1 multiple-choice answer

> Keep appending to this file as you continue. Each entry should have the prompt
> as typed, and a short note on what changed as a result.

---

## 1 — Initial prompt (verbatim)

> can you help me create a project for a competition - We plan to fast track
> candidates who complete an assignment to build a type of AI-powered application
> on Cloudflare. An AI-powered application should include the following
> components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history. ,
> learn more about cloudflare - https://agents.cloudflare.com/ ,
> https://developers.cloudflare.com/agents/ . Read the rules and conditions for
> the project and help me create one

**What the assistant did:**

1. Fetched and read `https://agents.cloudflare.com/` and
   `https://developers.cloudflare.com/agents/`, plus the Workers AI page for
   Llama 3.3 and the Agents SDK API reference, to establish the real API surface
   rather than working from memory.
2. Mapped each required component to a specific Cloudflare primitive and
   presented four candidate project ideas with a recommendation.

## 2 — Clarifying answer (multiple choice)

Asked which project to build and how to set it up. Selected:

- **Project:** Deep Research Agent — "chat a question → agent plans sub-questions
  → durable Workflow fans out web searches, dedupes, stores sources → streams a
  cited report."
- **Setup:** "Build from scratch, run locally" — no template, so every file is
  explainable in the submission.

**What the assistant did, in order:**

1. **Verified the API surface instead of guessing.** Installed `agents@0.23.0`
   and read the shipped `.d.ts` files to confirm the real signatures of
   `Agent<Env, State>`, `setState`, `initialState`, `this.sql`, `onStateChanged`,
   `runWorkflow`, `AgentWorkflow`, `reportProgress`, `onWorkflowProgress`,
   `@callable()` and `useAgent`. Several details in the prose docs were
   incomplete or differently named, so the types were treated as ground truth.
2. Worked around a local blocker: `npm` was pointed at an expired Amazon
   CodeArtifact token. Added a **project-local** `.npmrc` for the public registry
   rather than modifying the user's global config.
3. Wrote the server: `agent.ts` (Durable Object: state, memory, turn routing),
   `workflow.ts` (checkpointed pipeline), `ai.ts` (Workers AI wrappers),
   `prompts.ts` (all prompts in one file), `search.ts` (providers +
   `HTMLRewriter` extraction), `memory.ts` (SQLite + embedding recall).
4. Wrote the client: `App.tsx` driven entirely by synced state, and a
   dependency-free `Markdown.tsx` to avoid `dangerouslySetInnerHTML` on model
   output.
5. **Chose plain Vite + Wrangler assets over `@cloudflare/vite-plugin`**, because
   the plugin's SPA-plus-Worker config could not be verified from the docs
   available and `create-cloudflare` would not run non-interactively.
6. Found and fixed a routing conflict: `not_found_handling:
   single-page-application` would have served `index.html` for `/agents/*`, so
   the WebSocket upgrade never reached the Worker. Fixed with
   `assets.run_worker_first: ["/agents/*", "/api/*"]`.
7. Ran `wrangler types` and fixed six real type errors, including switching from
   `experimentalDecorators` to standard TC39 decorators (required by
   `@callable()`) and dropping `@cloudflare/workers-types` in favour of the
   generated runtime types.
8. Discovered that the `AI` binding forces `wrangler dev` to open a remote proxy
   session requiring credentials. Added a `demo` wrangler environment with no
   `ai` binding and canned fixtures so the app runs fully offline.
9. **Tested against a live server, not just the compiler.** Wrote WebSocket probe
   scripts that drive the real protocol. These found two genuine bugs:
   - the demo triage fixture hard-coded citations `[1]`/`[2]`, so every
     sub-question after the first reported zero sources;
   - `completeResearch` called `setState` twice, letting clients render a frame
     with the report present but the run still marked in progress.
10. Verified durability properly: confirmed **19 checkpointed steps** via the
    Workflows API, then killed the Worker mid-run and confirmed on restart that
    the Workflow resumed, completed, and delivered its report.
11. Wrote `README.md` and this file.

---

## Notes on how this was built

Two things are worth stating plainly for the reviewer.

**The docs were not treated as authoritative.** The Agents SDK is moving quickly
and the landing pages omit or rename parts of the API. Every server-side call in
this repo was checked against the type definitions in the installed package
before being written.

**Compiling was not treated as working.** The two real bugs in this project both
typechecked cleanly and were only found by driving the live WebSocket protocol
and reading what the server actually sent back. The probe scripts are not in the
repo because they are throwaway, but the behaviour they verified is listed under
"What I verified" in the README.
