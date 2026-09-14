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
 * The `demo` wrangler environment deliberately has no `ai` binding, so the
 * generated type makes `env.AI` optional. Everything below goes through here so
 * a misconfiguration produces one clear message instead of
 * "cannot read property 'run' of undefined".
 */
function ai(env: Env): Ai {
  if (!env.AI) {
    throw new Error(
      "No Workers AI binding. Either run the default environment (`npm run dev`, " +
        "after `wrangler login`) or use DEMO_MODE (`npm run dev:demo`).",
    );
  }
  return env.AI;
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

  const res = (await ai(env).run(CHAT_MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  })) as { response?: string };

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

  const stream = (await ai(env).run(CHAT_MODEL, {
    messages,
    stream: true,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  })) as unknown as ReadableStream<Uint8Array>;

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

  const res = (await ai(env).run(CHAT_MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.2,
    response_format: { type: "json_schema", json_schema: schema },
  })) as { response?: string | Record<string, unknown> };

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

  const res = (await ai(env).run(EMBED_MODEL, { text: texts })) as {
    data?: number[][];
  };
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
