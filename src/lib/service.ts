/**
 * Node `service`: the tool's functional area. Catalog tags mix area names with metadata
 * flags and inconsistent spellings ("issues", "Issues", "repos", "Repository Management"),
 * so tags are normalized to entity form and the most widely shared one wins. Tools with
 * no usable tag fall back to the main noun of their slug.
 */
import { NOISE, entityTokens, tokens } from "./text.ts";
import { type Tool, slugNouns } from "./schema.ts";

const META_TAG = /hint$|^(important|graphql|mcpignore|deprecated|mutation|batch|meta|miscellaneous|lookup|api|resource|ai)$/i;
const FILLER = new Set(["management", "and", "related", "general", "other"]);

function normTag(tag: string): string {
  const t = entityTokens(tokens(tag.replace(/&/g, " and ")).filter((x) => !FILLER.has(x) && !NOISE.has(x)));
  return t.slice(0, 2).join("-");
}

export function assignServices(tools: Tool[], prefix: string): Map<string, string> {
  const tagsOf = new Map<string, string[]>();
  const freq = new Map<string, number>();
  for (const t of tools) {
    const norm = [...new Set((t.tags ?? []).filter((x: string) => !META_TAG.test(x)).map(normTag).filter(Boolean))] as string[];
    tagsOf.set(t.slug, norm);
    for (const n of norm) freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const t of tools) {
    const norm = tagsOf.get(t.slug)!;
    const best = norm.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0];
    out.set(t.slug, best ?? slugNouns(t.slug, prefix)[0] ?? "general");
  }
  return out;
}
