/**
 * Optional LLM refinement. The rule pass proposes candidates; the model, given both
 * tools' descriptions, picks which producers really supply the value (or none, when the
 * user must provide it). It also gets a shortlist for id params the rules found nothing
 * for. Responses are cached on disk keyed by prompt hash, so reruns are free.
 *
 * Talks to any OpenAI-compatible endpoint; OpenRouter by default. Credentials, first match wins:
 *   key:  OPENROUTER_API_KEY | LLM_API_KEY | OPENAI_API_KEY
 *   url:  OPENROUTER_BASE_URL | LLM_BASE_URL | OPENAI_BASE_URL | https://openrouter.ai/api/v1
 *   model: DEP_GRAPH_MODEL (an OpenRouter model id, default openai/gpt-4o)
 * DEP_GRAPH_LLM=0 disables it. Any failure falls back to the rule selection for that group.
 */
import OpenAI from "openai";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { Candidate, Group, ScopingChoice, ToolInfo } from "./match.ts";

export const model = () => process.env.DEP_GRAPH_MODEL || "openai/gpt-4o";
const apiKey = () => process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = () =>
  process.env.OPENROUTER_BASE_URL || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
const CACHE_PATH = ".cache/llm.json";
const BATCH = 10;
const CONCURRENCY = 6;
const MAX_CANDIDATES = 8;

export function llmEnabled(): boolean {
  return !!apiKey() && process.env.DEP_GRAPH_LLM !== "0";
}

let cache: Record<string, any> = {};
function loadCache() {
  try {
    if (existsSync(CACHE_PATH)) cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    cache = {};
  }
}
function saveCache() {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

let client: OpenAI | undefined;
let jsonMode = true; // dropped for models that reject response_format

/** Parse a JSON object out of a reply, tolerating code fences or surrounding prose. */
function parseJSON(text: string): any {
  const t = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`model reply is not JSON: ${clip(text, 120)}`);
  }
}

async function chatJSON(system: string, user: string): Promise<any> {
  const h = createHash("sha256").update(model() + "\n" + system + "\n" + user).digest("hex");
  if (cache[h]) return cache[h];
  client ??= new OpenAI({
    apiKey: apiKey(),
    baseURL: baseURL(),
    defaultHeaders: { "X-Title": "composio-dep-graph-generator" },
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await client.chat.completions.create({
        model: model(),
        temperature: 0,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const parsed = parseJSON(r.choices[0]?.message?.content ?? "");
      cache[h] = parsed;
      return parsed;
    } catch (e: any) {
      lastErr = e;
      const status = e?.status as number | undefined;
      if (status === 401 || status === 402 || status === 403) throw e; // bad key / no credits: retrying won't help
      if (jsonMode && status === 400 && /response_format|json/i.test(String(e?.message))) {
        jsonMode = false;
        continue;
      }
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const SYSTEM = `You build dependency graphs for API tool catalogs used by an AI agent.
A consumer tool needs a required input value. For each case, choose which candidate
producer tools the agent can call FIRST to obtain that exact value, e.g. a list tool
whose results include the identifier the consumer needs.
Rules:
- Include every candidate that genuinely returns this value for the SAME kind of entity.
  Two entities can share an attribute name (both have an "id" or a "name") and still be
  different things; read both tools' descriptions to tell them apart. There are often
  several valid producers: list, search, and create tools for that entity are all
  valid. Do not stop at the one the parameter description happens to mention.
- Exclude candidates where the value only appears incidentally inside an unrelated record,
  or where the entity differs.
- Order best-first (the most direct way to discover the value), at most 5.
- Return an empty list ONLY when no candidate returns this value at all, e.g. the input is
  free-form content, a new name being created, or an enum choice.
Respond with JSON: {"cases":[{"case":"<case id>","producers":[<candidate numbers>]}]}`;

interface Case {
  id: string;
  group: Group;
  candidates: Candidate[];
}

/**
 * Shortlist tools by name, to add to the rule candidates: list/search/get tools whose slug
 * nouns share the input's entity or the nouns of its description ("a branch or tag name"
 * -> branch, tag). Catches values the output schemas don't name the same way.
 */
function retrieveCandidates(g: Group, infos: ToolInfo[], exclude: Set<string>, n: number): Candidate[] {
  const want = new Set(g.hints);
  if (!want.size || n <= 0) return [];
  const rank = { list: 0, create: 1, get: 2, mutate: 3 } as const;
  return infos
    .filter((t) => t.slug !== g.consumer && t.kind !== "mutate" && !exclude.has(t.slug))
    .filter((t) => !t.inputs.some((i) => i.param === g.input.param))
    .map((t) => ({ t, hit: t.nouns.filter((x) => want.has(x)).length, extra: t.nouns.length }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || rank[a.t.kind] - rank[b.t.kind] || a.extra - b.extra)
    .slice(0, n)
    .map(({ t }) => ({ from: t.slug, to: g.consumer, label: g.input.param, source_field: "", score: 0.4 }));
}

/**
 * Returns a map from group index to the LLM-chosen candidates. Groups absent from the
 * map (not sent, or failed) keep their rule-based selection.
 */
export async function refineWithLLM(groups: Group[], infos: ToolInfo[]): Promise<Map<number, Candidate[]>> {
  loadCache();
  const byslug = new Map(infos.map((t) => [t.slug, t]));
  const cases: Case[] = [];
  groups.forEach((g, i) => {
    if (g.context) return; // scoping params are handled by rules (same few producers everywhere)
    const cands = g.candidates.filter((c) => c.score >= 0.2).slice(0, MAX_CANDIDATES);
    // Top up with name-based retrieval so the model can recover what the schemas miss.
    cands.push(...retrieveCandidates(g, infos, new Set(cands.map((c) => c.from)), MAX_CANDIDATES + 2 - cands.length));
    if (cands.length) cases.push({ id: `c${i}`, group: g, candidates: cands });
  });

  const out = new Map<number, Candidate[]>();
  const batches: Case[][] = [];
  for (let i = 0; i < cases.length; i += BATCH) batches.push(cases.slice(i, i + BATCH));
  let done = 0;
  let failed = 0;

  await pool(batches, CONCURRENCY, async (batch) => {
    const body = batch
      .map((c) => {
        const consumer = byslug.get(c.group.consumer)!;
        const lines = c.candidates.map((cand, k) => {
          const p = byslug.get(cand.from)!;
          const field = cand.source_field ? ` [returns ${cand.source_field}]` : "";
          return `  ${k + 1}. ${p.slug}${field}: ${clip(p.description, 160)}`;
        });
        return [
          `CASE ${c.id}`,
          `consumer: ${consumer.slug}: ${clip(consumer.description, 200)}`,
          `needs: ${c.group.input.param} — ${clip(c.group.input.description, 200)}`,
          `candidates:`,
          ...lines,
        ].join("\n");
      })
      .join("\n\n");
    try {
      const res = await chatJSON(SYSTEM, body);
      for (const r of res.cases ?? []) {
        const c = batch.find((x) => x.id === r.case);
        if (!c || !Array.isArray(r.producers)) continue;
        const picks = (r.producers as unknown[])
          .map((n) => c.candidates[Number(n) - 1])
          .filter((x): x is Candidate => !!x)
          .slice(0, 5)
          .map((x, rank) => ({ ...x, score: Math.max(x.score, 0.9 - 0.1 * rank) }));
        // Guard against over-pruning: an exact, top-scoring rule match survives a
        // blanket "none" from the model.
        if (!picks.length && (c.candidates[0]?.score ?? 0) >= 0.9) picks.push(c.candidates[0]);
        out.set(Number(c.id.slice(1)), [...new Map(picks.map((p) => [p.from, p])).values()]);
      }
    } catch (e) {
      failed++;
      console.error(`llm batch failed: ${(e as Error).message}`);
    }
    done++;
    if (done % 10 === 0 || done === batches.length) {
      console.error(`llm: ${done}/${batches.length} batches`);
      saveCache();
    }
  });
  saveCache();
  if (failed) console.error(`llm: ${failed} batches failed, rule selection kept for those`);
  return out;
}

const SCOPING_SYSTEM = `You build dependency graphs for API tool catalogs used by an AI agent.
Some inputs (like an account or workspace identifier) are needed by most tools. For each
such input, pick the ONE candidate tool an agent should call by default to discover valid
values for the current user. Prefer, in order:
- a tool that needs no inputs of its own (it can be called first);
- the most general listing of the entities the user works with, not a filtered subset
  (special-purpose or filtered listings, or listings of everything public);
- for inputs needed together, the SAME tool, so the values come from one record.
Respond with JSON, naming each tool by its exact slug:
{"picks":[{"param":"<name>","tool":"<slug>"}]}`;

/** One call: choose the default producer for each scoping param. Missing/failed -> rules. */
export async function chooseScopingWithLLM(choices: ScopingChoice[], infos: ToolInfo[]): Promise<Map<string, string>> {
  loadCache();
  const byslug = new Map(infos.map((t) => [t.slug, t]));
  const body = choices
    .map((c) =>
      [
        `PARAM ${c.param} — ${clip(c.description, 200)}` +
          (c.together.length ? `\n  usually needed together with: ${c.together.join(", ")}` : ""),
        ...c.ranked.map((s) => {
          const t = byslug.get(s);
          const needs = t?.inputs.map((i) => i.param).join(", ") || "nothing";
          return `  - ${s} (needs: ${needs}): ${clip(t?.description ?? "", 160)}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
  const out = new Map<string, string>();
  try {
    const res = await chatJSON(SCOPING_SYSTEM, body);
    for (const p of res.picks ?? []) {
      const c = choices.find((x) => x.param === p.param);
      const tool = c?.ranked.find((s) => s === String(p.tool).trim());
      if (c && tool) out.set(c.param, tool);
    }
  } catch (e) {
    console.error(`llm scoping choice failed: ${(e as Error).message}`);
  }
  saveCache();
  return out;
}
