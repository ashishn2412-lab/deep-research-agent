/**
 * The durable research pipeline.
 *
 * Each `step.do()` is a checkpoint: its return value is persisted, so if the
 * Worker is evicted, an upstream API times out, or the whole run is retried, the
 * completed steps are replayed from storage rather than re-executed. A research
 * run that takes two minutes and thirty model calls survives a deploy halfway
 * through.
 *
 * `AgentWorkflow` (from `agents/workflows`) gives us `this.agent` — a typed RPC
 * stub back to the Durable Object that started the run — plus `reportProgress`,
 * which is how the live UI stays in sync.
 */

import { AgentWorkflow, type AgentWorkflowStep } from "agents/workflows";
import type { WorkflowEvent } from "cloudflare:workers";

import type { ResearchAgent } from "./agent";
import { chat, chatJSON } from "./ai";
import { readPage, search } from "./search";
import {
  planPrompt,
  planSchema,
  queriesPrompt,
  queriesSchema,
  synthesizePrompt,
  triagePrompt,
  triageSchema,
} from "./prompts";
import type {
  ResearchProgress,
  ResearchWorkflowParams,
  Source,
  SubQuestion,
} from "@shared/types";

/** A page we fetched and scored, before it becomes a numbered citation. */
type ReadPage = {
  n: number;
  url: string;
  title: string;
  snippet: string;
  text: string;
};

type Finding = {
  subQuestion: string;
  notes: { n: number; text: string }[];
};

export class ResearchWorkflow extends AgentWorkflow<
  ResearchAgent,
  ResearchWorkflowParams,
  ResearchProgress,
  Env
> {
  async run(
    event: WorkflowEvent<ResearchWorkflowParams & Record<string, unknown>>,
    step: AgentWorkflowStep,
  ): Promise<{ question: string; sourceCount: number }> {
    const { question, memories, maxSubQuestions, maxPagesPerSubQuestion } =
      event.payload;

    // --- 1. Plan -----------------------------------------------------------
    await this.reportProgress({ kind: "phase", phase: "planning" });

    const plan = await step.do<SubQuestion[]>("plan", async () => {
      const result = await chatJSON<{ subQuestions: string[] }>(
        this.env,
        planPrompt(question, memories, maxSubQuestions),
        planSchema,
      );

      const cleaned = (result.subQuestions ?? [])
        .map((text) => text.trim())
        .filter((text) => text.length > 8)
        .slice(0, maxSubQuestions);

      if (cleaned.length === 0) {
        // Degrade rather than fail: research the question as asked.
        return [{ id: "sq-1", text: question, status: "pending", sourceCount: 0 }];
      }

      return cleaned.map<SubQuestion>((text, index) => ({
        id: `sq-${index + 1}`,
        text,
        status: "pending",
        sourceCount: 0,
      }));
    });

    await this.reportProgress({ kind: "plan", plan });

    // --- 2. Research each sub-question ------------------------------------
    await this.reportProgress({ kind: "phase", phase: "searching" });

    const findings: Finding[] = [];
    const allSources: Source[] = [];
    let citationNumber = 1;

    for (const subQuestion of plan) {
      await this.reportProgress({
        kind: "subQuestion",
        id: subQuestion.id,
        status: "running",
      });

      try {
        // 2a. Sub-question -> search queries.
        const queries = await step.do(`queries:${subQuestion.id}`, async () => {
          const result = await chatJSON<{ queries: string[] }>(
            this.env,
            queriesPrompt(subQuestion.text),
            queriesSchema,
          );
          const cleaned = (result.queries ?? [])
            .map((q) => q.trim())
            .filter(Boolean)
            .slice(0, 2);
          return cleaned.length > 0 ? cleaned : [subQuestion.text];
        });

        // 2b. Run the searches.
        const hits = await step.do(`search:${subQuestion.id}`, async () => {
          const collected: { url: string; title: string; snippet: string }[] = [];
          const seen = new Set<string>();

          for (const query of queries) {
            const { results, provider } = await search(this.env, query, 5);
            console.log(
              `[${subQuestion.id}] "${query}" -> ${results.length} results via ${provider}`,
            );
            for (const result of results) {
              if (seen.has(result.url)) continue;
              seen.add(result.url);
              collected.push(result);
            }
          }

          return collected.slice(0, maxPagesPerSubQuestion);
        });

        if (hits.length === 0) {
          await this.reportProgress({
            kind: "note",
            text: `No search results for "${subQuestion.text}"`,
          });
          await this.reportProgress({
            kind: "subQuestion",
            id: subQuestion.id,
            status: "failed",
            sourceCount: 0,
          });
          continue;
        }

        // 2c. Read the pages. One step per page keeps a single slow or dead
        //     page from invalidating the rest of the sub-question's work.
        await this.reportProgress({ kind: "phase", phase: "reading" });

        const pages: ReadPage[] = [];
        for (const hit of hits) {
          const n = citationNumber++;
          const page = await step.do(
            `read:${subQuestion.id}:${n}`,
            { retries: { limit: 1, delay: "2 seconds" } },
            async () => {
              try {
                const { text, title } = await readPage(this.env, hit.url);
                return {
                  n,
                  url: hit.url,
                  title: title || hit.title,
                  snippet: hit.snippet,
                  text: text || hit.snippet,
                };
              } catch (err) {
                console.warn(`read failed ${hit.url}: ${String(err)}`);
                // Fall back to the search snippet — thin, but still citable.
                return {
                  n,
                  url: hit.url,
                  title: hit.title,
                  snippet: hit.snippet,
                  text: hit.snippet,
                };
              }
            },
          );

          if (page.text.trim().length > 0) pages.push(page);
        }

        // 2d. Score relevance and extract findings.
        const triaged = await step.do(`triage:${subQuestion.id}`, async () => {
          const result = await chatJSON<{
            assessments: { n: number; relevance: number; findings?: string[] }[];
          }>(
            this.env,
            triagePrompt(
              subQuestion.text,
              pages.map((p) => ({
                n: p.n,
                title: p.title,
                url: p.url,
                text: p.text.slice(0, 4000),
              })),
            ),
            triageSchema,
            { maxTokens: 1500 },
          );
          return result.assessments ?? [];
        });

        const keptNumbers = new Set<number>();
        const notes: { n: number; text: string }[] = [];

        for (const assessment of triaged) {
          if (assessment.relevance < 0.4) continue;
          const page = pages.find((p) => p.n === assessment.n);
          if (!page) continue;

          keptNumbers.add(page.n);
          for (const finding of assessment.findings ?? []) {
            if (finding.trim()) notes.push({ n: page.n, text: finding.trim() });
          }
        }

        const kept = pages.filter((page) => keptNumbers.has(page.n));
        const sources = kept.map<Source>((page) => ({
          n: page.n,
          url: page.url,
          title: page.title,
          snippet: page.snippet || page.text.slice(0, 200),
          subQuestionId: subQuestion.id,
        }));

        allSources.push(...sources);
        if (notes.length > 0) {
          findings.push({ subQuestion: subQuestion.text, notes });
        }

        await this.reportProgress({ kind: "sources", sources });
        await this.reportProgress({
          kind: "subQuestion",
          id: subQuestion.id,
          status: sources.length > 0 ? "done" : "failed",
          sourceCount: sources.length,
        });
      } catch (err) {
        // One bad sub-question must not sink the whole report.
        console.error(`sub-question ${subQuestion.id} failed:`, err);
        await this.reportProgress({
          kind: "note",
          text: `Sub-question failed: ${subQuestion.text}`,
        });
        await this.reportProgress({
          kind: "subQuestion",
          id: subQuestion.id,
          status: "failed",
          sourceCount: 0,
        });
      }
    }

    // --- 3. Synthesise -----------------------------------------------------
    await this.reportProgress({ kind: "phase", phase: "synthesizing" });

    const report = await step.do("synthesize", async () => {
      if (allSources.length === 0) {
        return [
          `I could not find usable sources for **${question}**.`,
          "",
          "Every search either returned nothing or the pages could not be read.",
          "Try rephrasing the question, or add a `BRAVE_SEARCH_API_KEY` secret for",
          "higher-quality search results.",
        ].join("\n");
      }

      return chat(
        this.env,
        synthesizePrompt(question, findings, allSources, memories),
        { maxTokens: 2000, temperature: 0.3 },
      );
    });

    // --- 4. Persist and learn ---------------------------------------------
    // Writing through the Agent keeps SQLite as the single source of truth and
    // lets the Agent push the finished report to every connected browser.
    await step.do("persist", async () => {
      await this.agent.completeResearch(question, report, allSources);
    });

    await step.do("learn", async () => {
      await this.agent.learnFromExchange(question, report);
    });

    return { question, sourceCount: allSources.length };
  }
}
