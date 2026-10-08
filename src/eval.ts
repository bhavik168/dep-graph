/**
 * Score dependency_graph.json against hand-labeled cases.
 *   npm run eval                      -> dev set (eval/github_expected.json)
 *   npm run eval -- eval/github_heldout.json
 * A case's `must` entries are slugs, or arrays meaning "any one of these" (interchangeable
 * equivalents). `ok` lists other acceptable producers. Both empty = user-supplied value,
 * so any edge is a false positive. Reports micro precision/recall and every miss / FP.
 */
import { readFileSync } from "fs";

const exp = JSON.parse(readFileSync(process.argv[2] ?? "eval/github_expected.json", "utf-8"));
const g = JSON.parse(readFileSync(process.argv[3] ?? "dependency_graph.json", "utf-8"));
const P: string = exp.prefix ?? "";
const known = new Set<string>(g.nodes.map((n: any) => n.id));

let tp = 0, fp = 0, mustHit = 0, mustTotal = 0;
const problems: string[] = [];
for (const c of exp.cases) {
  const to = P + c.consumer;
  const must: string[][] = c.must.map((m: string | string[]) => (Array.isArray(m) ? m : [m]).map((s) => P + s));
  const okay = new Set<string>([...must.flat(), ...c.ok.map((s: string) => P + s)]);
  for (const s of okay) if (!known.has(s)) problems.push(`  ! unknown slug in labels: ${s}`);
  const got = g.edges.filter((e: any) => e.to === to && e.label === c.param).map((e: any) => e.from as string);
  for (const f of got) okay.has(f) ? tp++ : (fp++, problems.push(`  FP ${c.consumer}.${c.param} <- ${f.slice(P.length)}`));
  for (const anyOf of must) {
    mustTotal++;
    anyOf.some((m) => got.includes(m))
      ? mustHit++
      : problems.push(`  MISS ${c.consumer}.${c.param} <- ${anyOf.map((m) => m.slice(P.length)).join(" | ")}`);
  }
}
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = mustTotal ? mustHit / mustTotal : 1;
console.log(problems.join("\n"));
console.log(
  JSON.stringify({ cases: exp.cases.length, edges_scored: tp + fp, precision: +precision.toFixed(3), recall: +recall.toFixed(3),
    f1: +((2 * precision * recall) / (precision + recall || 1)).toFixed(3) }, null, 2),
);
