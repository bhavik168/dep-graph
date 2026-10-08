/**
 * Token-level helpers shared by the input and output sides, so both normalize names
 * the same way (`pullNumber`, `pull_number`, `PullRequest` -> comparable tokens).
 */

export function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(xes|ches|shes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Common API abbreviations. Generic software vocabulary, not tied to one toolkit. */
const ABBREV: Record<string, string[]> = {
  repo: ["repository"],
  org: ["organization"],
  pr: ["pull", "request"],
  env: ["environment"],
  username: ["user", "name"],
  userid: ["user", "id"],
  config: ["configuration"],
  dir: ["directory"],
};

/** Normalize a token list into entity tokens: abbreviations expanded, singularized, deduped. */
export function entityTokens(toks: string[]): string[] {
  const out: string[] = [];
  for (const t of toks) {
    for (const x of ABBREV[t] ?? ABBREV[singular(t)] ?? [singular(t)]) {
      const y = ABBREV[x]?.length === 1 ? ABBREV[x][0] : x;
      if (!out.includes(y)) out.push(y);
    }
  }
  return out;
}

/**
 * Identifier attributes. An input like `issue_number` splits into entity [issue] +
 * attr `number`; an output field `Issue.number` yields the same pair.
 */
export const ATTR_CLASS: Record<string, string> = {
  id: "id",
  uuid: "id",
  guid: "id",
  node_id: "node_id",
  number: "number",
  num: "number",
  name: "handle",
  login: "handle",
  slug: "handle",
  handle: "handle",
  sha: "sha",
  oid: "sha",
  digest: "sha",
  ref: "ref",
  key: "key",
};
export const isAttr = (t: string) => t in ATTR_CLASS;

/** Words that carry no entity meaning in schema/def names. */
export const NOISE = new Set([
  "a", "an", "the", "for", "of", "by", "in", "to", "on", "from", "with", "and", "or",
  "response", "wrapper", "result", "results", "data", "item", "items", "info", "detail",
  "details", "simple", "minimal", "full", "nullable", "public", "private", "basic",
  "object", "model", "schema", "entry", "entries", "record", "records", "node", "nodes",
  "edge", "edges", "list", "value", "values", "payload", "output", "input", "summary",
]);

/** Verbs that open tool slugs, grouped by how useful such a tool is as an id *source*. */
export const VERBS: Record<string, "list" | "create" | "get" | "mutate"> = {
  list: "list", search: "list", find: "list", query: "list", enumerate: "list", browse: "list",
  create: "create", add: "create", fork: "create", start: "create", generate: "create",
  import: "create", upload: "create", register: "create", invite: "create", open: "create",
  get: "get", fetch: "get", retrieve: "get", read: "get", check: "get", view: "get",
  download: "get", describe: "get", lookup: "get",
};
