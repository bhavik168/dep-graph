/**
 * Turn a tool's JSON-Schema input/output into flat, comparable records:
 * required inputs ("what this tool consumes") and identifier-like output fields
 * ("what this tool can produce"), each reduced to entity tokens + attribute.
 */
import { ATTR_CLASS, NOISE, VERBS, entityTokens, isAttr, singular, tokens } from "./text.ts";

export type Tool = Record<string, any>;

export interface InputKey {
  param: string;
  entity: string[]; // e.g. [issue]; [] when the param is a bare attribute like `sha`
  attr: string | null; // e.g. "number"; null for a bare noun like `branch` (its identifier)
  description: string;
  type?: string;
}

export interface OutputField {
  path: string; // e.g. data.issues[].number
  entities: string[][]; // alternative entity readings (container key, $def name)
  attr: string | null;
  depth: number; // object hops below the returned record (0 = the record itself)
  record: string[]; // entity of the depth-0 record this field hangs off (e.g. [repository])
}

const GENERIC_CONTAINERS = new Set([
  "data", "items", "results", "nodes", "edges", "records", "entries", "values", "list", "response", "result",
]);

/** Toolkit prefix shared by all slugs (e.g. "GITHUB_"), detected from the catalog. */
export function slugPrefix(slugs: string[]): string {
  const firsts = new Map<string, number>();
  for (const s of slugs) {
    const f = s.split("_")[0];
    firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }
  const [top, n] = [...firsts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return n >= slugs.length * 0.8 ? top + "_" : "";
}

export function slugTokens(slug: string, prefix: string): string[] {
  return tokens(slug.startsWith(prefix) ? slug.slice(prefix.length) : slug);
}

export function verbKind(slug: string, prefix: string): "list" | "create" | "get" | "mutate" {
  const t = slugTokens(slug, prefix);
  if (t[0] === "get" && (t[1] === "all" || t.includes("list"))) return "list";
  for (const w of t.slice(0, 2)) if (VERBS[w]) return VERBS[w];
  return "mutate";
}

/** Nouns of a slug (verbs and stopwords removed), used as consumer/producer context. */
export function slugNouns(slug: string, prefix: string): string[] {
  return entityTokens(slugTokens(slug, prefix).filter((t) => !VERBS[t] && !NOISE.has(t)));
}

/** Split a parameter name into entity + attr. */
export function parseName(name: string): { entity: string[]; attr: string | null } {
  let t = tokens(name);
  if (t.length === 1 && t[0] === "username") t = ["user", "login"];
  const n = t.length;
  if (n >= 2 && t[n - 2] === "node" && t[n - 1] === "id")
    return { entity: entityTokens(t.slice(0, -2)), attr: "node_id" };
  const last = singular(t[n - 1] ?? "");
  if (isAttr(last)) return { entity: entityTokens(t.slice(0, -1)), attr: last };
  return { entity: entityTokens(t), attr: null };
}

/** Entity tokens of a $def name: `CreateAnIssueResponse` -> [issue]. Only the tool's own
 * leading verb is stripped, so nouns that double as verbs (`CheckRun`) survive. */
function defTokens(defName: string | undefined, prefix: string, slug: string): string[] {
  if (!defName) return [];
  const ownVerb = slugTokens(slug, prefix)[0];
  const kit = prefix.replace(/_$/, "").toLowerCase();
  const t = tokens(defName).filter((x, i) => !(i === 0 && x === ownVerb) && !NOISE.has(x) && x !== kit);
  return entityTokens(t);
}

export function requiredInputs(tool: Tool): InputKey[] {
  const ip = tool.inputParameters ?? tool.input_parameters ?? tool.parameters ?? {};
  const props = ip.properties ?? {};
  const req: string[] = ip.required ?? [];
  return req.map((p) => {
    const s = props[p] ?? {};
    const { entity, attr } = parseName(p);
    return {
      param: p,
      entity,
      attr,
      description: String(s.description ?? s.title ?? ""),
      type: s.type ?? (s.anyOf?.[0]?.type as string | undefined),
      ...(s.enum ? { enum: true } : {}),
    } as InputKey & { enum?: boolean };
  });
}

/**
 * Walk the output schema, resolving $ref/$defs, and emit identifier-like fields.
 * Each field gets alternative entity readings from (a) its own compound name
 * (`workflow_id`), (b) the property that contains it (`issues[]` -> issue),
 * (c) the $def it lives in (`Issue`, `CreateAnIssueResponse` -> issue).
 */
export function outputFields(tool: Tool, prefix: string): OutputField[] {
  const op = tool.outputParameters ?? tool.output_parameters ?? {};
  const defs = { ...(op.$defs ?? {}), ...(op.definitions ?? {}) };
  const root = op.properties?.data ?? op;
  const out: OutputField[] = [];
  const seen = new Set<string>();

  const walk = (
    schema: any,
    path: string,
    container: string,
    defName: string | undefined,
    depth: number,
    stack: string[],
    record: string[],
  ) => {
    if (!schema || typeof schema !== "object" || stack.length > 8) return;
    if (schema.$ref) {
      const n = String(schema.$ref).split("/").pop()!;
      if (stack.includes(n)) return;
      return walk(defs[n], path, container, n, depth, [...stack, n], record);
    }
    for (const k of ["anyOf", "oneOf", "allOf"]) for (const s of schema[k] ?? []) walk(s, path, container, defName, depth, stack, record);
    if (schema.items) walk(schema.items, path + "[]", container, defName, depth, stack, record);
    for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
      const fp = `${path}.${k}`;
      const ft = tokens(k);
      const isObj = v && (v.$ref || v.properties || v.items || v.anyOf || v.oneOf || v.allOf);
      const { entity: fEnt, attr: fAttr } = parseName(k);
      const containerEnt = GENERIC_CONTAINERS.has(container) ? [] : entityTokens(tokens(container));
      const dEnt = defTokens(defName, prefix, tool.slug ?? "");

      if (fAttr && ft.length >= 1 && (ATTR_CLASS[fAttr] || fAttr === "node_id")) {
        const entities: string[][] = [];
        if (fEnt.length) entities.push(fEnt); // workflow_id, head_sha
        else {
          if (containerEnt.length) entities.push(containerEnt);
          if (dEnt.length) entities.push(dEnt);
          if (!entities.length) entities.push(slugNouns(tool.slug ?? "", prefix));
        }
        // A reading that is a strict subset of another is less specific
        // (`Run` vs `check_runs[]`): drop it so the qualifier isn't lost.
        const specific = entities.filter(
          (e, i) =>
            !entities.some((o, j) => j !== i && o.length > e.length && e.every((t) => o.includes(t))) &&
            entities.findIndex((o) => o.join("_") === e.join("_")) === i,
        );
        const sig = `${specific.map((e) => e.join("_")).join("|")}:${fAttr}:${depth}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          out.push({ path: fp, entities: specific, attr: fAttr, depth, record });
        }
      } else if (!isObj && v?.type === "string" && fEnt.length && !fAttr) {
        // Bare noun string field (e.g. `head_branch`, `default_branch`): can serve a
        // bare-noun input like `branch`.
        const sig = `${fEnt.join("_")}:null:${depth}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          out.push({ path: fp, entities: [fEnt], attr: null, depth, record });
        }
      }
      if (isObj) {
        // The returned records themselves sit at depth 0: `data.issues[]` (a list
        // result) or a generic wrapper like `data.items[]` does not add a hop.
        const isArr = v.type === "array" || !!v.items;
        const same = GENERIC_CONTAINERS.has(k) || (path === "data" && isArr);
        const rec = depth === 0 && !same ? (containerEnt.length ? containerEnt : dEnt.length ? dEnt : record) : record;
        walk(v, fp, k, defName, same ? depth : depth + 1, stack, same ? (GENERIC_CONTAINERS.has(k) ? record : entityTokens(tokens(k))) : rec);
      }
    }
  };

  walk(root, "data", "data", undefined, 0, [], slugNouns(tool.slug ?? "", prefix));
  return out;
}
