/**
 * DEMO_MODE: canned model + search output so the whole app can be run and
 * demoed with no Cloudflare account and no network access.
 *
 * This exists because Workers AI always executes on Cloudflare's network — even
 * under `wrangler dev` the `AI` binding is a remote call, so without an account
 * the UI cannot be exercised at all. Flip DEMO_MODE to "true" in wrangler.jsonc
 * to work on the interface offline.
 *
 * Nothing here is used when DEMO_MODE is "false" (the default).
 */

import type { Msg } from "./ai";
import { TASK } from "./prompts";

export function isDemoMode(env: Env): boolean {
  // `String()` widens the literal type that `wrangler types` infers from the
  // default value in wrangler.jsonc, which would otherwise make this comparison
  // a type error the moment the default is "false".
  return String(env.DEMO_MODE) === "true";
}

/** Read the `Task: <name>` marker that every system prompt starts with. */
function taskOf(messages: Msg[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  return system.match(/^Task:\s*(\w+)/m)?.[1] ?? "unknown";
}

function lastUser(messages: Msg[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

export function demoChat(messages: Msg[]): string {
  const task = taskOf(messages);

  if (task === TASK.synthesize) {
    return [
      "Cloudflare Workflows and AWS Step Functions solve the same problem —",
      "durable multi-step execution — but they sit at different points on the",
      "cost and latency curve. Workflows bills on CPU time and runs beside your",
      "code at the edge [1]; Step Functions bills per state transition and is",
      "centralised in a region [2].",
      "",
      "## Programming model",
      "",
      "Workflows are plain TypeScript classes where each durable boundary is a",
      "`step.do()` call [1]. Step Functions defines the state machine in Amazon",
      "States Language, separate from the handler code [2].",
      "",
      "## Cost shape for agents",
      "",
      "Agent workloads spend most of their wall-clock time waiting on model",
      "inference. Because Workers charge for CPU time rather than wall time, that",
      "waiting is close to free [1]. Step Functions' per-transition pricing makes",
      "chatty agent loops more expensive as step counts grow [2].",
      "",
      "## Sources",
      "",
      "[1] Cloudflare Workflows documentation — https://developers.cloudflare.com/workflows/",
      "[2] AWS Step Functions documentation — https://docs.aws.amazon.com/step-functions/",
      "",
      "_(DEMO_MODE output — no model was called.)_",
    ].join("\n");
  }

  return [
    "This is DEMO_MODE, so no model was called and this reply is canned.",
    "",
    `You said: "${lastUser(messages).slice(0, 200)}"`,
    "",
    "Set `DEMO_MODE` to `\"false\"` in wrangler.jsonc and run `wrangler login` to",
    "use Llama 3.3 on Workers AI for real.",
  ].join("\n");
}

export function demoJSON<T>(messages: Msg[]): T {
  const task = taskOf(messages);
  const user = lastUser(messages);

  switch (task) {
    case TASK.route: {
      // The real router is an LLM call. Offline we approximate it: once a report
      // exists, only a fresh interrogative starts new research — everything else
      // is a follow-up. Without this, a sentence like "I prefer tables, summarise
      // the report" would kick off a whole second research run.
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const reportExists = system.includes("A report already exists");
      const opensWithQuestionWord =
        /^\s*(what|how|why|when|which|who|where|compare|contrast|is|are|does|do|should|can)\b/i.test(
          user,
        );

      const looksLikeResearch = reportExists
        ? opensWithQuestionWord && user.trim().split(/\s+/).length > 5
        : user.trim().endsWith("?") || user.trim().split(/\s+/).length > 6;

      return {
        mode: looksLikeResearch ? "research" : "chat",
        question: user,
        reason: "DEMO_MODE heuristic",
      } as T;
    }

    case TASK.plan:
      return {
        subQuestions: [
          `What are the core capabilities relevant to: ${user.slice(0, 80)}?`,
          "What do the official docs say about pricing and limits?",
          "What trade-offs do practitioners report in production?",
        ],
      } as T;

    case TASK.queries:
      return {
        queries: [user.replace(/[?]/g, "").split(/\s+/).slice(0, 8).join(" ")],
      } as T;

    case TASK.triage: {
      // Citation numbers keep climbing across sub-questions, so the fixture has
      // to read the actual `SOURCE [n]` markers out of the prompt rather than
      // assume [1] and [2] — otherwise every sub-question after the first finds
      // no matching assessment and looks like it failed.
      const numbers = [...user.matchAll(/SOURCE \[(\d+)\]/g)].map((m) =>
        Number.parseInt(m[1], 10),
      );
      const findings = [
        "Durable execution retries individual steps without replaying the whole run",
        "Billing is based on CPU time rather than wall-clock time",
        "Per-state-transition pricing grows with step count",
      ];
      return {
        assessments: numbers.map((n, index) => ({
          n,
          relevance: index === 0 ? 0.9 : 0.6,
          findings: [findings[index % findings.length]],
        })),
      } as T;
    }

    case TASK.remember: {
      // A crude stand-in for the real extractor, so the memory panel is
      // actually exercisable offline. The real prompt is far more selective.
      const userLine = user.match(/^USER:\s*(.*)$/m)?.[1] ?? "";
      if (/\b(prefer|always|never|i like|don't|do not)\b/i.test(userLine)) {
        return {
          memories: [{ kind: "preference", text: userLine.trim().slice(0, 160) }],
        } as T;
      }
      return { memories: [] } as T;
    }

    default:
      return {} as T;
  }
}

/**
 * Deterministic pseudo-embedding: hashes tokens into a 768-dim bag-of-words
 * vector. Not semantically meaningful, but stable and the right shape, so
 * similarity search runs end-to-end offline.
 */
export function demoEmbedding(text: string): number[] {
  const dims = 768;
  const vector = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dims] += 1;
  }
  return vector;
}

export function demoSearchResults(query: string) {
  return [
    {
      url: "https://developers.cloudflare.com/workflows/",
      title: "Cloudflare Workflows · Durable execution on Workers",
      snippet: `Demo result for "${query}". Workflows provide durable, multi-step execution.`,
    },
    {
      url: "https://docs.aws.amazon.com/step-functions/",
      title: "AWS Step Functions Developer Guide",
      snippet: `Demo result for "${query}". Step Functions coordinates distributed components.`,
    },
  ];
}

export function demoPageText(url: string): string {
  return [
    `Demo page body for ${url}.`,
    "Durable execution means each step is checkpointed, so a failure retries only",
    "that step instead of replaying the entire run. Workers bill for CPU time",
    "rather than wall-clock time, so waiting on a model or a human costs nothing.",
    "Per-state-transition pricing, by contrast, grows with the number of steps.",
  ].join(" ");
}
