/**
 * Every prompt the agent sends to Llama 3.3 lives here, so the reasoning
 * behaviour is auditable in one file.
 *
 * Each system prompt starts with a `Task: <name>` line. That line is what
 * DEMO_MODE keys off to return canned output, and it makes traces easy to read.
 */

import type { Msg } from "./ai";
import type { Source } from "@shared/types";

export const TASK = {
  route: "route",
  plan: "plan",
  queries: "queries",
  triage: "triage",
  synthesize: "synthesize",
  remember: "remember",
  chat: "chat",
} as const;

/** Decide whether a user turn needs a full research run or a quick answer. */
export function routePrompt(
  userText: string,
  hasReport: boolean,
  currentQuestion: string | null,
): Msg[] {
  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.route}`,
        "You are the router for a deep-research agent. Classify the user's message.",
        "",
        'Choose "research" when the user asks a substantive question that benefits from',
        "searching the web and reading several sources: comparisons, evaluations,",
        '"how does X work", market or technology landscape questions, anything where',
        "citations matter.",
        "",
        'Choose "chat" when the user is following up on the existing report, asking for',
        "reformatting, asking about you, greeting you, stating a preference, or asking",
        "something answerable from context without new sources.",
        "",
        hasReport
          ? `A report already exists for: "${currentQuestion}". Follow-ups about it are "chat".`
          : "No report exists yet in this session.",
        "",
        'For "research", rewrite the message into a single self-contained question.',
      ].join("\n"),
    },
    { role: "user", content: userText },
  ];
}

export const routeSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["research", "chat"] },
    question: { type: "string" },
    reason: { type: "string" },
  },
  required: ["mode", "question"],
};

/** Break a question into independent, searchable sub-questions. */
export function planPrompt(
  question: string,
  memories: string[],
  maxSubQuestions: number,
): Msg[] {
  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.plan}`,
        "You plan research. Break the user's question into between 2 and",
        `${maxSubQuestions} sub-questions that can each be researched independently.`,
        "",
        "Rules:",
        "- Each sub-question must be answerable by reading a few web pages.",
        "- Cover distinct angles; do not restate the same question twice.",
        "- Prefer concrete, specific phrasings over broad ones.",
        "- If the question implies a comparison, dedicate sub-questions to each side",
        "  plus one to the trade-offs between them.",
        memories.length
          ? `\nWhat you already know about this user:\n${memories.map((m) => `- ${m}`).join("\n")}`
          : "",
      ].join("\n"),
    },
    { role: "user", content: question },
  ];
}

export const planSchema = {
  type: "object",
  properties: {
    subQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["subQuestions"],
};

/** Turn a sub-question into literal search-engine queries. */
export function queriesPrompt(subQuestion: string): Msg[] {
  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.queries}`,
        "Convert the sub-question into 1-2 search engine queries.",
        "Use keyword style, not natural language. No quotes, no operators, no",
        "site: filters. Keep each query under 12 words.",
      ].join("\n"),
    },
    { role: "user", content: subQuestion },
  ];
}

export const queriesSchema = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["queries"],
};

/**
 * Score fetched pages for relevance and pull out the claims worth citing.
 * This is what stops the final report from being padded with junk sources.
 */
export function triagePrompt(
  subQuestion: string,
  pages: { n: number; title: string; url: string; text: string }[],
): Msg[] {
  const corpus = pages
    .map((p) => `--- SOURCE [${p.n}] ${p.title} (${p.url})\n${p.text}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.triage}`,
        "You are triaging sources for one sub-question.",
        "For each source, decide if it actually helps answer the sub-question.",
        "Give a relevance score from 0 to 1, and if the score is 0.4 or above,",
        "extract up to 3 short factual findings from that source.",
        "",
        "Never invent findings. Only state what the source text supports. If a source",
        "is a navigation page, paywall, error page or otherwise empty of substance,",
        "score it 0.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `SUB-QUESTION: ${subQuestion}\n\n${corpus}`,
    },
  ];
}

export const triageSchema = {
  type: "object",
  properties: {
    assessments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "number" },
          relevance: { type: "number" },
          findings: { type: "array", items: { type: "string" } },
        },
        required: ["n", "relevance"],
      },
    },
  },
  required: ["assessments"],
};

/** Write the final cited report. */
export function synthesizePrompt(
  question: string,
  findings: { subQuestion: string; notes: { n: number; text: string }[] }[],
  sources: Source[],
  memories: string[],
): Msg[] {
  const evidence = findings
    .map((f) => {
      const notes = f.notes.map((n) => `  - ${n.text} [${n.n}]`).join("\n");
      return `### ${f.subQuestion}\n${notes || "  (no usable sources found)"}`;
    })
    .join("\n\n");

  const sourceList = sources
    .map((s) => `[${s.n}] ${s.title} — ${s.url}`)
    .join("\n");

  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.synthesize}`,
        "Write a research report in Markdown answering the user's question, using",
        "only the evidence supplied below.",
        "",
        "Hard rules:",
        "- Cite with bracketed numbers matching the source list, e.g. [2]. Every",
        "  non-obvious claim needs a citation.",
        "- Never cite a number that is not in the source list.",
        "- If the evidence is thin or contradictory on a point, say so plainly",
        "  instead of guessing. A short honest report beats a padded one.",
        "- Do not restate the question as a preamble. Start with the answer.",
        "",
        "Structure:",
        "- Open with a 2-3 sentence direct answer.",
        "- Then sections covering the substance.",
        "- End with a `## Sources` section listing only the sources you cited.",
        memories.length
          ? `\nUser preferences to respect:\n${memories.map((m) => `- ${m}`).join("\n")}`
          : "",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `QUESTION: ${question}`,
        "",
        "EVIDENCE:",
        evidence,
        "",
        "SOURCE LIST:",
        sourceList || "(none)",
      ].join("\n"),
    },
  ];
}

/**
 * Extract durable facts worth remembering across sessions. Deliberately
 * conservative — an agent that "remembers" noise gets worse over time.
 */
export function rememberPrompt(transcript: string): Msg[] {
  return [
    {
      role: "system",
      content: [
        `Task: ${TASK.remember}`,
        "Extract only durable, reusable facts about this user from the exchange.",
        "",
        'Save a "preference" for how they want answers (format, depth, tone, units).',
        'Save a "fact" for stable context about them (role, domain, stack, constraints).',
        "",
        "Do NOT save: the question they asked, the answer contents, one-off requests,",
        "anything you inferred rather than were told, or anything already obvious.",
        "Return an empty array if nothing durable was revealed. That is the common case.",
      ].join("\n"),
    },
    { role: "user", content: transcript },
  ];
}

export const rememberSchema = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["preference", "fact"] },
          text: { type: "string" },
        },
        required: ["kind", "text"],
      },
    },
  },
  required: ["memories"],
};

/** Conversational turn: follow-ups grounded in the current report and memory. */
export function chatPrompt(
  userText: string,
  report: string | null,
  question: string | null,
  memories: string[],
  history: { role: "user" | "assistant"; content: string }[],
): Msg[] {
  const context: string[] = [
    `Task: ${TASK.chat}`,
    "You are a research assistant on Cloudflare. Be direct and concise.",
    "Answer from the report and conversation below. If the answer requires new",
    "sources you do not have, say so and offer to run a fresh research pass.",
  ];

  if (memories.length) {
    context.push(
      "",
      `What you know about this user:\n${memories.map((m) => `- ${m}`).join("\n")}`,
    );
  }

  if (report && question) {
    context.push(
      "",
      `Current report answers: "${question}"`,
      "",
      "REPORT:",
      report.slice(0, 9000),
    );
  } else {
    context.push("", "No research has been run in this session yet.");
  }

  return [
    { role: "system", content: context.join("\n") },
    ...history.slice(-6),
    { role: "user", content: userText },
  ];
}
