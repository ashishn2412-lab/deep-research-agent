/**
 * Workers AI helpers.
 *
 * Everything the agent thinks with goes through here: Llama 3.3 70B for
 * reasoning and bge-base for embeddings. Both run on Cloudflare's network via
 * the `AI` binding, so there are no third-party API keys in this project.
 */

import { isDemoMode, demoChat, demoJSON, demoEmbedding } from "./demo";

/** Llama 3.3 70B, fp8-quantised. Supports function calling; 24k context. */
export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** 768-dimension embeddings, used for semantic memory recall. */
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

/**
 * Workers AI can be reached two ways, and this project supports both.
 *
 *  - **binding** (`env.AI`): the normal path, and the only one that works when
 *    deployed. Under `wrangler dev` the binding runs in *remote* mode, which
 *    requires the account to have a workers.dev subdomain registered.
 *  - **REST** (`CF_ACCOUNT_ID` + `CF_AI_API_TOKEN`): plain HTTPS to
 *    api.cloudflare.com. Needs no binding and no subdomain, so it unblocks local
 *    development on an account that has not been through Workers onboarding.
 *
 * REST wins when both are configured, because it is only ever set deliberately.
 */
type Provider =
  | { kind: "rest"; accountId: string; token: string }
  | { kind: "binding"; ai: Ai };

function provider(env: Env): Provider {
  if (env.CF_ACCOUNT_ID && env.CF_AI_API_TOKEN) {
    return {
      kind: "rest",
      accountId: env.CF_ACCOUNT_ID,
      token: env.CF_AI_API_TOKEN,
    };
  }
  if (env.AI) return { kind: "binding", ai: env.AI };

  throw new Error(
    "No way to reach Workers AI. Pick one: (a) `npm run dev` with a workers.dev " +
      "subdomain registered, (b) `npm run dev:rest` with CF_ACCOUNT_ID and " +
      "CF_AI_API_TOKEN in .dev.vars, or (c) `npm run dev:demo` for offline fixtures.",
  );
}

/**
 * Preflight: is a model reachable at all? Returns the reason if not.
 *
 * Without this the agent starts a Workflow that fails inside its first step,
 * and Workflows retries with backoff before giving up — so the UI would sit on a
 * spinner for a long time before showing a misconfiguration the server already
 * knew about at turn zero.
 */
export function modelUnavailableReason(env: Env): string | null {
  if (isDemoMode(env)) return null;
  try {
    provider(env);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function restUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
}

/** Run a model and return its parsed result, via whichever provider is configured. */
async function runModel<T>(
  env: Env,
  model: string,
  inputs: Record<string, unknown>,
): Promise<T> {
  const target = provider(env);

  if (target.kind === "binding") {
    return (await target.ai.run(
      model as Parameters<Ai["run"]>[0],
      inputs as Parameters<Ai["run"]>[1],
    )) as T;
  }

  const res = await fetch(restUrl(target.accountId, model), {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(inputs),
  });

  if (!res.ok) {
    throw new Error(
      `Workers AI REST ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as {
    success: boolean;
    result?: T;
    errors?: unknown[];
  };
  if (!body.success) {
    throw new Error(`Workers AI REST error: ${JSON.stringify(body.errors)}`);
  }
  return body.result as T;
}

/** Same as `runModel`, but returns the raw SSE byte stream. */
async function runModelStream(
  env: Env,
  model: string,
  inputs: Record<string, unknown>,
): Promise<ReadableStream<Uint8Array>> {
  const target = provider(env);

  if (target.kind === "binding") {
    return (await target.ai.run(
      model as Parameters<Ai["run"]>[0],
      { ...inputs, stream: true } as Parameters<Ai["run"]>[1],
    )) as unknown as ReadableStream<Uint8Array>;
  }

  const res = await fetch(restUrl(target.accountId, model), {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...inputs, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(
      `Workers AI REST stream ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res.body;
}

type ChatOptions = {
  maxTokens?: number;
  temperature?: number;
};

/** Single-shot completion returning plain text. */
export async function chat(
  env: Env,
  messages: Msg[],
  opts: ChatOptions = {},
): Promise<string> {
  if (isDemoMode(env)) return demoChat(messages);

  const res = await runModel<{ response?: string }>(env, CHAT_MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  });

  return (res.response ?? "").trim();
}

/**
 * Streaming completion. Yields text deltas as they arrive so the UI can render
 * tokens live. Workers AI returns SSE; we parse it here.
 */
export async function* chatStream(
  env: Env,
  messages: Msg[],
  opts: ChatOptions = {},
): AsyncGenerator<string> {
  if (isDemoMode(env)) {
    for (const word of demoChat(messages).split(/(\s+)/)) {
      await new Promise((r) => setTimeout(r, 12));
      yield word;
    }
    return;
  }

  const stream = await runModelStream(env, CHAT_MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as { response?: string };
          if (parsed.response) yield parsed.response;
        } catch {
          // Partial or non-JSON keep-alive frame; ignore.
        }
      }
    }
  }
}

/**
 * Structured output. Asks the model for JSON matching `schema` using Workers AI
 * `response_format`, then falls back to extracting the first JSON object from a
 * plain-text reply if the model ignores the constraint.
 */
export async function chatJSON<T>(
  env: Env,
  messages: Msg[],
  schema: Record<string, unknown>,
  opts: ChatOptions = {},
): Promise<T> {
  if (isDemoMode(env)) return demoJSON<T>(messages);

  const res = await runModel<{ response?: string | Record<string, unknown> }>(
    env,
    CHAT_MODEL,
    {
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
      response_format: { type: "json_schema", json_schema: schema },
    },
  );

  const raw = res.response;
  if (raw && typeof raw === "object") return raw as T;

  return parseLooseJSON<T>(String(raw ?? ""));
}

/** Extract a JSON value from text that may be wrapped in prose or fences. */
export function parseLooseJSON<T>(text: string): T {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // Widest brace/bracket span, for replies like `Sure! {...}`.
  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Model did not return usable JSON: ${trimmed.slice(0, 200)}`);
}

/** Embed one or more strings. Returns one vector per input, in order. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (isDemoMode(env)) return texts.map(demoEmbedding);

  const res = await runModel<{ data?: number[][] }>(env, EMBED_MODEL, {
    text: texts,
  });
  const vectors = res.data ?? [];
  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: asked for ${texts.length}, got ${vectors.length}`,
    );
  }
  return vectors;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
