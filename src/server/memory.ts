/**
 * Durable memory, stored in the Durable Object's embedded SQLite database.
 *
 * Two layers:
 *   1. `memories`   - durable facts/preferences about the user, embedded with
 *                     bge-base so they can be recalled semantically.
 *   2. `reports`    - every research report ever produced in this session,
 *                     retrievable long after it left the synced state.
 *
 * Similarity search runs in JS over the stored vectors. At one Durable Object
 * per user this is the right trade-off: no extra binding, no paid plan, and a
 * few hundred vectors compare in well under a millisecond. Vectorize is the
 * migration path if a single session ever holds tens of thousands of memories.
 */

import { cosineSimilarity, embed } from "./ai";
import type { MemoryItem, PastReport, Source } from "@shared/types";

/** Tagged-template SQL function, as exposed by `Agent#sql`. */
export type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

type MemoryRow = {
  id: string;
  kind: string;
  text: string;
  embedding: string;
  created_at: number;
};

type ReportRow = {
  id: string;
  question: string;
  report_md: string;
  sources_json: string;
  created_at: number;
};

export function ensureSchema(sql: SqlFn): void {
  sql`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      text       TEXT NOT NULL,
      embedding  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  sql`
    CREATE TABLE IF NOT EXISTS reports (
      id           TEXT PRIMARY KEY,
      question     TEXT NOT NULL,
      report_md    TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    )
  `;
  // Sources seen across all runs, so repeat research can note prior coverage.
  sql`
    CREATE TABLE IF NOT EXISTS seen_sources (
      url        TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      times_seen INTEGER NOT NULL DEFAULT 1,
      last_seen  INTEGER NOT NULL
    )
  `;
  sql`CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC)`;
}

// --- memories ---------------------------------------------------------------

/**
 * Save a memory, skipping near-duplicates. Returns the stored item, or null if
 * an existing memory already covers it.
 */
export async function saveMemory(
  env: Env,
  sql: SqlFn,
  kind: "preference" | "fact",
  text: string,
): Promise<MemoryItem | null> {
  const clean = text.trim();
  if (clean.length < 4) return null;

  const [vector] = await embed(env, [clean]);

  // Reject anything that restates an existing memory.
  for (const row of sql<MemoryRow>`SELECT * FROM memories`) {
    if (cosineSimilarity(vector, JSON.parse(row.embedding) as number[]) > 0.94) {
      return null;
    }
  }

  const item: MemoryItem = {
    id: crypto.randomUUID(),
    kind,
    text: clean,
    createdAt: Date.now(),
  };

  sql`
    INSERT INTO memories (id, kind, text, embedding, created_at)
    VALUES (${item.id}, ${item.kind}, ${item.text}, ${JSON.stringify(vector)}, ${item.createdAt})
  `;

  return item;
}

/** Semantic recall: the `topK` memories most related to `query`. */
export async function recallMemories(
  env: Env,
  sql: SqlFn,
  query: string,
  topK = 5,
  minScore = 0.3,
): Promise<MemoryItem[]> {
  const rows = sql<MemoryRow>`SELECT * FROM memories`;
  if (rows.length === 0) return [];

  const [queryVector] = await embed(env, [query]);

  return rows
    .map((row) => ({
      row,
      score: cosineSimilarity(queryVector, JSON.parse(row.embedding) as number[]),
    }))
    .filter((scored) => scored.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ row }) => toMemoryItem(row));
}

export function listMemories(sql: SqlFn, limit = 50): MemoryItem[] {
  return sql<MemoryRow>`
    SELECT * FROM memories ORDER BY created_at DESC LIMIT ${limit}
  `.map(toMemoryItem);
}

export function forgetMemory(sql: SqlFn, id: string): void {
  sql`DELETE FROM memories WHERE id = ${id}`;
}

function toMemoryItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind === "preference" ? "preference" : "fact",
    text: row.text,
    createdAt: row.created_at,
  };
}

// --- reports ----------------------------------------------------------------

export function saveReport(
  sql: SqlFn,
  question: string,
  markdown: string,
  sources: Source[],
): PastReport {
  const report: PastReport = {
    id: crypto.randomUUID(),
    question,
    createdAt: Date.now(),
  };

  sql`
    INSERT INTO reports (id, question, report_md, sources_json, created_at)
    VALUES (${report.id}, ${question}, ${markdown}, ${JSON.stringify(sources)}, ${report.createdAt})
  `;

  return report;
}

export function listReports(sql: SqlFn, limit = 20): PastReport[] {
  return sql<{ id: string; question: string; created_at: number }>`
    SELECT id, question, created_at FROM reports
    ORDER BY created_at DESC LIMIT ${limit}
  `.map((row) => ({
    id: row.id,
    question: row.question,
    createdAt: row.created_at,
  }));
}

export function getReport(
  sql: SqlFn,
  id: string,
): { question: string; markdown: string; sources: Source[] } | null {
  const [row] = sql<ReportRow>`SELECT * FROM reports WHERE id = ${id}`;
  if (!row) return null;
  return {
    question: row.question,
    markdown: row.report_md,
    sources: JSON.parse(row.sources_json) as Source[],
  };
}

// --- seen sources -----------------------------------------------------------

export function recordSeenSources(sql: SqlFn, sources: Source[]): void {
  const now = Date.now();
  for (const source of sources) {
    sql`
      INSERT INTO seen_sources (url, title, times_seen, last_seen)
      VALUES (${source.url}, ${source.title}, 1, ${now})
      ON CONFLICT(url) DO UPDATE SET
        times_seen = times_seen + 1,
        last_seen  = ${now}
    `;
  }
}
