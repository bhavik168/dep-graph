/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 *   node --import tsx src/generate.ts path/to/catalog.json
 *
 * The catalog path is the last CLI argument. Writes `dependency_graph.json` (and the
 * `dependency_graph.html` viewer) to the working directory.
 *
 * Pipeline (nothing toolkit-specific is hardcoded):
 *   1. schema.ts   flatten each tool's required inputs and identifier-like outputs
 *                  ($ref/$defs resolved) into entity tokens + attribute
 *   2. match.ts    join consumer inputs against producer outputs and score each pairing
 *                  (attribute fit, entity fit in context, producer kind, nesting depth)
 *   3. llm.ts      optional: an LLM confirms/reorders candidates per (tool, input) and
 *                  rescues inputs the rules found nothing for (OpenRouter or any OpenAI-compatible key)
 *   4. emit        top producers per input -> edges producer -> consumer, label = input
 */
import { existsSync, readFileSync, writeFileSync } from "fs";

// Local credentials (OPENROUTER_API_KEY, DEP_GRAPH_MODEL, ...; see lib/llm.ts) from .env, if present.
// Variables already set in the environment win.
if (existsSync(".env")) process.loadEnvFile(".env");
import { type Tool, slugPrefix } from "./lib/schema.ts";
import { type Candidate, analyze, buildGroups, selectByRules, selectScoping } from "./lib/match.ts";
import { assignServices } from "./lib/service.ts";
import { chooseScopingWithLLM, model, llmEnabled, refineWithLLM } from "./lib/llm.ts";
import { renderHTML } from "./lib/visualize.ts";

interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
  source_field?: string;
  confidence?: number;
  context?: boolean;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

// The catalog path is the last CLI argument (appended after the run command).
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";
const HTML_PATH = "dependency_graph.html";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  const list: Tool[] = Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
  return list
    .map((t) => ({ ...t, slug: slugOf(t) }))
    .filter((t) => !!t.slug);
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

async function generate(tools: Tool[]): Promise<Graph> {
  const prefix = slugPrefix(tools.map((t) => t.slug));
  const infos = analyze(tools, prefix);
  const groups = buildGroups(infos);

  let scoping = selectScoping(groups, infos);
  let chosen: Candidate[][] = groups.map((g) => scoping.picks.get(g) ?? selectByRules(g));
  if (llmEnabled()) {
    console.error(`refining ${groups.filter((g) => !g.context).length} inputs with ${model()}`);
    const refined = await refineWithLLM(groups, infos);
    scoping = selectScoping(groups, infos, await chooseScopingWithLLM(scoping.choices, infos));
    chosen = groups.map((g, i) => scoping.picks.get(g) ?? refined.get(i) ?? chosen[i]);
  } else {
    console.error("no LLM key (OPENROUTER_API_KEY / LLM_API_KEY / OPENAI_API_KEY): rule-based inference only");
  }

  const services = assignServices(tools, prefix);
  const nodes: Node[] = tools.map((t) => ({ id: t.slug, service: services.get(t.slug) }));

  const seen = new Set<string>();
  const edges: Edge[] = [];
  groups.forEach((g, i) => {
    for (const c of chosen[i]) {
      const k = `${c.from}>${c.to}>${c.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({
        from: c.from,
        to: c.to,
        label: c.label,
        ...(c.source_field ? { source_field: c.source_field } : {}),
        confidence: Number(Math.min(1, c.score).toFixed(2)),
        ...(g.context ? { context: true } : {}),
      });
    }
  });
  edges.sort((a, b) => a.to.localeCompare(b.to) || a.label!.localeCompare(b.label!) || b.confidence! - a.confidence!);
  return { nodes, edges };
}

async function main() {
  const tools = loadCatalog();
  const graph = await generate(tools);
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  const kit = tools[0]?.toolkit?.name ?? slugPrefix(tools.map((t) => t.slug)).replace(/_$/, "").toLowerCase();
  writeFileSync(HTML_PATH, renderHTML(graph, kit.charAt(0).toUpperCase() + kit.slice(1)), "utf-8");
  const ctx = graph.edges.filter((e) => e.context).length;
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges (${ctx} scoping) to ${OUT_PATH} and ${HTML_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
