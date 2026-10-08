/**
 * Rule-based candidate generation and ranking: join each consumer's required inputs
 * against every other tool's identifier outputs, score each pairing, keep the best few.
 */
import { ATTR_CLASS, NOISE, entityTokens, isAttr, tokens } from "./text.ts";
import {
  type InputKey, type OutputField, type Tool, outputFields, requiredInputs, slugNouns, verbKind,
} from "./schema.ts";

export interface ToolInfo {
  slug: string;
  name: string;
  description: string;
  kind: ReturnType<typeof verbKind>;
  nouns: string[];
  deprecated: boolean;
  inputs: InputKey[];
  outputs: OutputField[];
}

export interface Candidate {
  from: string;
  to: string;
  label: string;
  source_field: string;
  score: number;
}

export interface Group {
  consumer: string;
  input: InputKey;
  context: boolean; // ubiquitous scoping param (owner/repo-like)
  hints: string[]; // entity nouns from the consumer + param description, for LLM shortlist retrieval
  candidates: Candidate[]; // sorted, unpruned
}

const KIND_SCORE = { list: 1, create: 0.8, get: 0.6, mutate: 0.35 } as const;
const MAX_DEPTH = 2;

export function analyze(tools: Tool[], prefix: string): ToolInfo[] {
  return tools.map((t) => ({
    slug: t.slug,
    name: String(t.name ?? t.slug),
    description: String(t.description ?? ""),
    kind: verbKind(t.slug, prefix),
    nouns: slugNouns(t.slug, prefix),
    deprecated: !!t.isDeprecated || (t.tags ?? []).includes("deprecated"),
    inputs: requiredInputs(t),
    outputs: outputFields(t, prefix),
  }));
}

const key = (i: { entity: string[]; attr: string | null }) => `${i.entity.join("_")}:${i.attr ?? ""}`;

function attrScore(inp: InputKey, f: OutputField): number {
  if (inp.attr === null) {
    if (f.attr === null) return 0.8;
    return ATTR_CLASS[f.attr] === "handle" ? 1 : 0;
  }
  if (f.attr === inp.attr) return 1;
  if (f.attr && ATTR_CLASS[f.attr] === ATTR_CLASS[inp.attr]) return 0.7;
  // Content-addressed objects are identified by their hash (`commit_id` <- commit.sha).
  const pair = [ATTR_CLASS[inp.attr], ATTR_CLASS[f.attr ?? ""]].sort().join("/");
  if (pair === "id/sha") return 0.6;
  return 0;
}

/**
 * How well a producer's entity reading matches what the consumer asks for.
 * Extra qualifier tokens on either side are accepted only when the other side's
 * context mentions them: `run_id` on "re-run a workflow" accepts `workflow_run.id`
 * (workflow is in context) and rejects `check_run.id`.
 */
function entityScore(ec: string[], ep: string[], consumerCtx: Set<string>, producerCtx: Set<string>): number {
  if (!ep.length) return 0;
  // Treat a compound word as containing its tail (`webhook` covers `hook`).
  const norm = (a: string[], b: string[]) =>
    a.map((t) => b.find((u) => u !== t && u.length >= 4 && t.length > u.length && t.endsWith(u)) ?? t);
  ep = norm(ep, ec);
  const epSet = new Set(ep);
  const ecSet = new Set(ec);
  if (ec.every((t) => epSet.has(t))) {
    const extra = ep.filter((t) => !ecSet.has(t));
    if (!extra.length) return 1;
    const hit = extra.filter((t) => consumerCtx.has(t)).length;
    return hit === extra.length ? 0.95 : hit ? 0.7 : 0.45;
  }
  if (ep.every((t) => ecSet.has(t))) {
    const missing = ec.filter((t) => !epSet.has(t));
    return missing.every((t) => producerCtx.has(t)) ? 0.85 : 0.4;
  }
  return 0;
}

export function buildGroups(infos: ToolInfo[]): Group[] {
  // Which params are ubiquitous scoping context (e.g. owner/repo): required by many tools.
  const freq = new Map<string, number>();
  for (const t of infos) for (const i of t.inputs) freq.set(i.param, (freq.get(i.param) ?? 0) + 1);
  const contextThreshold = Math.max(5, infos.length * 0.08);

  // Nouns that name real entities (they carry an id/handle somewhere in the catalog).
  const knownEntities = new Set<string>();
  for (const t of infos)
    for (const f of t.outputs)
      if (f.attr && ["id", "handle", "number"].includes(ATTR_CLASS[f.attr] ?? ""))
        for (const e of f.entities) if (e.length === 1) knownEntities.add(e[0]);

  // Index producer fields by entity token.
  type Hit = { tool: ToolInfo; field: OutputField; ent: string[] };
  const byToken = new Map<string, Hit[]>();
  for (const t of infos)
    for (const f of t.outputs) {
      if (f.depth > MAX_DEPTH) continue;
      if (f.attr === null && !knownEntities.has(f.entities[0].at(-1)!)) continue;
      for (const ent of f.entities)
        for (const tok of new Set(ent)) {
          if (!byToken.has(tok)) byToken.set(tok, []);
          byToken.get(tok)!.push({ tool: t, field: f, ent });
        }
    }

  const groups: Group[] = [];
  for (const consumer of infos) {
    for (const inp of consumer.inputs) {
      if ((inp as any).enum || inp.type === "boolean") continue;
      if (inp.attr === null && !inp.entity.every((t) => knownEntities.has(t) || NOISE.has(t))) continue;
      if (inp.attr === null && !knownEntities.has(inp.entity.at(-1) ?? "")) continue;

      const descEnt = entityTokens(tokens(inp.description)).filter(
        (t) => !NOISE.has(t) && !isAttr(t) && knownEntities.has(t),
      );
      // Context: the consumer's slug nouns, this param's description, and the entities of
      // its other required inputs (a repo-scoped tool prefers repo-scoped producers).
      const consumerCtx = new Set([
        ...consumer.nouns,
        ...entityTokens(tokens(inp.description)),
        ...consumer.inputs.filter((o) => o !== inp).flatMap((o) => o.entity),
      ]);
      let ec = inp.entity;
      if (!ec.length) {
        // Bare attribute (`sha`, `name`, `ref`): a create tool's `name`/`key` is the user's new
        // value; otherwise the param's description says what it names ("the name of the variable").
        const cls = ATTR_CLASS[inp.attr ?? ""];
        if (consumer.kind === "create" && (cls === "handle" || cls === "key")) continue;
        ec = descEnt.length ? descEnt : consumer.nouns;
        if (!ec.length) continue;
      }
      const ownKey = key(inp);

      const best = new Map<string, Candidate>();
      const pool = new Set<Hit>();
      for (const tok of ec) for (const h of byToken.get(tok) ?? []) pool.add(h);
      for (const [tok, hits] of byToken) // compound tails: `hook` -> `webhook`
        if (tok.length > 4 && ec.some((t) => t.length >= 4 && tok.endsWith(t) && tok !== t)) for (const h of hits) pool.add(h);
      for (const { tool: p, field: f, ent } of pool) {
        if (p.slug === consumer.slug) continue;
        if (p.inputs.some((pi) => pi.param === inp.param || key(pi) === ownKey)) continue; // circular
        const a = attrScore(inp, f);
        if (!a) continue;
        const e = inp.entity.length
          ? entityScore(ec, ent, consumerCtx, new Set(p.nouns))
          : ent.some((t) => ec.includes(t)) && ent.every((t) => consumerCtx.has(t)) ? 0.6 : 0;
        if (!e) continue;
        // Nested fields (an owner inside a repository record) are fine when the record
        // they hang off is what the consumer talks about, weaker otherwise.
        const onTopic = f.record.some((t) => consumerCtx.has(t));
        const depthF = (onTopic ? 0.85 : 0.6) ** f.depth;
        // Affinity: producers whose own slug shares the consumer's qualifiers (runner
        // labels from a runner tool, not issue labels) rank above generic matches.
        const shared = p.nouns.filter((t) => consumerCtx.has(t) && !ec.includes(t)).length;
        const affinity = 0.75 + 0.125 * Math.min(shared, 2);
        const nonContextReqs = p.inputs.filter((pi) => (freq.get(pi.param) ?? 0) < contextThreshold).length;
        const s =
          (a * e * affinity * KIND_SCORE[p.kind] * depthF * (p.deprecated ? 0.6 : 1)) /
          (1 + 0.08 * nonContextReqs + 0.02 * p.inputs.length);
        const prev = best.get(p.slug);
        if (!prev || prev.score < s)
          best.set(p.slug, { from: p.slug, to: consumer.slug, label: inp.param, source_field: f.path, score: s });
      }
      groups.push({
        consumer: consumer.slug,
        input: inp,
        context: (freq.get(inp.param) ?? 0) >= contextThreshold,
        hints: [...new Set([...ec, ...descEnt])],
        candidates: [...best.values()].sort(
          (x, y) => y.score - x.score || x.from.length - y.from.length || x.from.localeCompare(y.from),
        ),
      });
    }
  }
  return groups;
}

/** Rule-only selection: top-k per (consumer, param), relative to the best candidate. */
export function selectByRules(g: Group, k = 5): Candidate[] {
  const top = g.candidates[0]?.score ?? 0;
  return g.candidates.filter((c) => c.score >= 0.3 && c.score >= top * 0.65).slice(0, k);
}

/**
 * Scoping params (owner/repo-like) get ONE producer, the same across the catalog: the tool
 * that ranks first for that param most often. Every tool needs these values, so repeating
 * several producers per consumer would bury the id dependencies in near-duplicate edges.
 */
export interface ScopingChoice {
  param: string;
  description: string; // a representative description of the param
  together: string[]; // other scoping params usually required alongside this one
  ranked: string[]; // shortlist, rule choice first
}

export function selectScoping(
  groups: Group[],
  infos: ToolInfo[],
  override: Map<string, string> = new Map(),
): { picks: Map<Group, Candidate[]>; choices: ScopingChoice[] } {
  const nouns = new Map(infos.map((t) => [t.slug, t.nouns.length]));
  const byslug = new Map(infos.map((t) => [t.slug, t]));
  // wins[param][tool]: how often the tool ties for first place on that param.
  const wins = new Map<string, Map<string, number>>();
  for (const g of groups) {
    if (!g.context || !g.candidates.length) continue;
    const top = g.candidates[0].score;
    const m = wins.get(g.input.param) ?? new Map<string, number>();
    for (const c of g.candidates) if (c.score >= top - 1e-9) m.set(c.from, (m.get(c.from) ?? 0) + 1);
    wins.set(g.input.param, m);
  }
  // Prefer a tool that supplies the scoping values a consumer needs together (owner AND
  // repo from one repository listing). Other params count by how often they co-occur
  // with this one on the same consumer.
  const params = new Map<string, Set<string>>();
  for (const g of groups) if (g.context) (params.get(g.consumer) ?? params.set(g.consumer, new Set()).get(g.consumer)!).add(g.input.param);
  const cooc = (a: string, b: string) => {
    let both = 0, n = 0;
    for (const ps of params.values()) if (ps.has(a)) (n++, ps.has(b) && both++);
    return n ? both / n : 0;
  };
  const canonical = new Map<string, string>();
  const choices: ScopingChoice[] = [];
  for (const [param, m] of wins) {
    const total = (tool: string) =>
      m.get(tool)! + [...wins].reduce((a, [p, o]) => a + (p === param ? 0 : cooc(param, p) * (o.get(tool) ?? 0)), 0);
    // Near-ties (within 5%) go to the most general tool: fewest qualifiers in its name
    // ("repositories for the user" over "repositories starred by the user").
    const best = Math.max(...[...m.keys()].map(total));
    const near = [...m.keys()].filter((t) => total(t) >= best * 0.95);
    near.sort((a, b) => nouns.get(a)! - nouns.get(b)! || total(b) - total(a) || a.localeCompare(b));
    const rest = [...m.keys()].filter((t) => !near.includes(t)).sort((a, b) => total(b) - total(a));
    // A default discovery tool must be callable first: keep only tools with no required
    // inputs, unless there are none.
    const all = [...near, ...rest];
    const free = all.filter((t) => byslug.get(t)?.inputs.length === 0);
    const ranked = (free.length ? free : all).slice(0, 8);
    const sample = groups.find((g) => g.context && g.input.param === param)!;
    const together = [...wins.keys()].filter((p) => p !== param && cooc(param, p) >= 0.5);
    choices.push({ param, description: sample.input.description, together, ranked });
    canonical.set(param, override.get(param) ?? ranked[0]);
  }
  const out = new Map<Group, Candidate[]>();
  for (const g of groups) {
    if (!g.context) continue;
    const pick = g.candidates.find((c) => c.from === canonical.get(g.input.param)) ?? g.candidates[0];
    out.set(g, pick ? [pick] : []);
  }
  return { picks: out, choices };
}
