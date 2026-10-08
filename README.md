# build a tool dependency graph generator (60-120 mins)

we care about the quality and structure of the dependency relationships you discover

some actions need precursor actions before being able to execute them

a concrete example

1. the tool `GITHUB_CREATE_AN_ISSUE_COMMENT` which needs an `issue_number`
2. which can be got by `GITHUB_LIST_REPOSITORY_ISSUES` as an example, there could be other ways to get an `issue_number` too

a second more dense exmaple
the merge tool `GITHUB_MERGE_A_PULL_REQUEST` needs a `pull_number`, if you only have a branch name you first list the pull requests with `GITHUB_LIST_PULL_REQUESTS` to find the matching one and then you can merge it

when we agentically execute actions inside composio, we need to know either what info to get from the user or what other action we should take before we execute the action.

you are supposed to build a program that generates this dependency graph — a generator that reads a toolkit's tool catalog and outputs the graph, instead of hand-writing it

to keep this limited in scope, we give you [Github](https://docs.composio.dev/toolkits/github) as an example toolkit to build and test against — but your generator should generalize: it reads a toolkit's catalog and produces the graph, so it works for any toolkit, not just this one

the final submission should be a visualized dependency graph where i can see connection (this is not super important just should exist for me to see if graph with edges and nodes)

## deliverable

commit a **generator** at the repo root — a program that produces a `dependency_graph.json` from a toolkit's catalog. we run it: your generator is called with the path to a toolkit's catalog as a command-line argument (e.g. `node src/generate.ts path/to/catalog.json`), and it writes `dependency_graph.json` at the repo root (declare build/run in `generator.json`). it must read the catalog it's given, not hardcode a fixed graph. the graph shape our checks read:

```json
{
  "nodes": [{ "id": "GITHUB_CREATE_AN_ISSUE", "service": "issues" }],
  "edges": [{ "from": "GITHUB_LIST_REPOSITORY_ISSUES", "to": "GITHUB_CREATE_AN_ISSUE_COMMENT", "label": "issue_number" }]
}
```

- each edge is `producer -> consumer`; `label` is the id/field the producer supplies (e.g. `issue_number`, `pull_number`).
- use Composio's tool slugs for node ids (e.g. `GITHUB_CREATE_AN_ISSUE`), taken from the catalog you were given.
- also commit a visualization (nodes + edges you can see) and the tool catalog you use.

## get started

1. the GitHub tool catalog is already provided at `github_catalog.json` — no api key needed.
2. write your generator in `src/generate.ts` to read a toolkit's catalog and produce the graph. run `npm run selfcheck` to try it on `github_catalog.json` as you iterate.
3. use node/tsx or python (`bun` isn't guaranteed when we run your generator).

for language models, use the **AI API credentials** (a Base URL and API key) shown on your Litmus assessment page. they work with the OpenAI SDK: point the client's `baseURL`/`base_url` at that url and pass the key, and call an allowed model such as `openai/gpt-4o`. your usage counts against the assessment's token budget.

you can implement this with whatever language you want, feel free to use language models and coding tools

## submit

once you are done, run `litmus submit` from your assessment folder. make sure your generator (see **deliverable** above) is committed.

## activity tracking

your work is tracked automatically while you work (file changes, git history, and AI-tool prompts) and included when you `litmus submit`. there is nothing to run, just commit often.

NOTE:  Feel free to use LLM, you will be judged by the quality of output, eval...

---

# Solution

## Run it

```bash
npm install --legacy-peer-deps
cp .env.example .env            # optional: LLM credentials + model (see below)
node --import tsx src/generate.ts github_catalog.json   # or: node src/generate.ts github_catalog.json
```

Writes `dependency_graph.json` (the graph) and `dependency_graph.html` (the viewer) to the working directory. Open the HTML file in a browser: search for a tool, click it to see what it needs and what it unlocks.

- **LLM credentials** are read from `OPENROUTER_API_KEY`/`OPENROUTER_BASE_URL`, `LLM_API_KEY`/`LLM_BASE_URL`, or `OPENAI_API_KEY`/`OPENAI_BASE_URL` (first match wins), from the environment or `.env`. Any OpenAI-compatible endpoint works.
- **Model:** `DEP_GRAPH_MODEL` (default `openai/gpt-4o`). `DEP_GRAPH_LLM=0` forces rules only.
- **No key, or the endpoint is down:** the generator still runs, using rules only.
- **Cache:** model answers are stored in `.cache/llm.json`, keyed by a hash of the prompt. It is committed, so rerunning on `github_catalog.json` reproduces this graph without spending tokens.

## Output

| | |
|---|---|
| Nodes | 893 (every tool in the catalog; ids are catalog slugs) |
| Edges | 2,808: 1,658 id dependencies across 99 labels + 1,150 scoping edges |
| Services | 92, from the catalog's tags (normalized) |

Each edge is `producer -> consumer` with `label` = the consumer's input. Extra fields: `source_field` (where the value appears in the producer's output, e.g. `data.issues[].number`), `confidence`, and `context: true` on scoping edges.

**Scoping edges.** `owner`, `repo`, `org` and `username` are required by hundreds of tools. Each gets one producer, the same catalog-wide (e.g. `repo` and `owner` ← `LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER`), so they don't bury the id dependencies. The viewer hides them by default.

## How it works

Nothing toolkit-specific is hardcoded; every step reads the catalog it is given.

1. **Flatten schemas** (`src/lib/schema.ts`). Each tool's required inputs and its identifier-like output fields (`$ref`/`$defs` resolved) become *entity + attribute* pairs:
   - `issue_number` → (issue, number)
   - output `data.issues[].number` → (issue, number), with the entity read from the field name, its container (`issues[]`), and the `$def` name (`Issue`, `CreateAnIssueResponse`)
2. **Match and score** (`src/lib/match.ts`). Each required input is joined against every other tool's outputs. A pairing is scored on:
   - attribute fit (exact, same class like `name`/`login`, or `id`/`sha` for content-addressed objects)
   - entity fit in context (`run_id` on "re-run a workflow" accepts `workflow_run.id`, rejects `check_run.id`)
   - producer kind (list/search > create > get)
   - nesting depth, and whether the producer is scoped like the consumer
   - circular producers (ones that already need the value) are dropped
3. **Verify with an LLM** (`src/lib/llm.ts`). For each (tool, input), the model sees both tools' descriptions and up to ~10 candidates: the rule matches plus tools found by name ("a branch or tag name" → `LIST_BRANCHES`). It picks the real producers by number, so it can't invent edges. A top rule match (score ≥ 0.9) survives if the model rejects everything.
4. **Emit** the top producers per input (≤5), plus the scoping edges, and render the viewer (`src/lib/visualize.ts`).

## Evaluation

`npm run eval` scores the graph against hand-labeled ground truth (`npm run eval -- eval/github_heldout.json` for the held-out set). The generator never reads these files.

- **Dev set** (`eval/github_expected.json`, 31 inputs): labeled by me; used while developing.
- **Held-out set** (`eval/github_heldout.json`, 30 inputs): drawn at random (fixed seed) and labeled by a separate agent that saw only the catalog, never the code or output. Not used for tuning.

| Mode | Dev P / R / F1 | Held-out P / R / F1 |
|---|---|---|
| Rules only | 0.762 / 0.893 / 0.823 | 0.676 / 0.783 / 0.725 |
| **Rules + `openai/gpt-4o`** (default) | 0.865 / 0.964 / 0.912 | **0.926 / 0.783 / 0.848** |
| Rules + `openai/gpt-4.1` | 0.778 / 0.964 / 0.861 | 0.831 / 0.913 / 0.870 |
| Rules + `anthropic/claude-sonnet-4.5` | 0.800 / 0.964 / 0.874 | 0.848 / 0.826 / 0.837 |
| Rules + `openai/gpt-4o-mini` | 0.862 / 0.964 / 0.910 | 0.800 / 0.870 / 0.833 |
| Rules + `google/gemini-2.5-pro` | 0.664 / 0.964 / 0.786 | 0.783 / 0.913 / 0.843 |

- The LLM pass is clearly worth it: on held-out it lifts precision from 0.68 to 0.93.
- Differences between models are within noise (one held-out case ≈ 3–4 points). `gpt-4o` is the default for the best precision on both sets: a wrong edge sends an agent to the wrong tool, a missing one only means asking the user.
- Dev recall (0.96) is higher than held-out (0.78): the dev set is where fixes were made, so the held-out number is the honest one.

**Generalization check.** On a made-up 7-tool Slack-style catalog the generator found 9 of 10 expected edges with the LLM pass (4 with rules only).

## Known limitations

- Inputs whose names don't resemble any output field can be missed, e.g. `account_id` (a user's `id`), a GraphQL `tierId`, or a Slack-style `message_ts`.
- Optional inputs are not linked; only required ones.
- The eval sets are small (31 + 30 inputs), so treat scores as direction, not precision.

## Files

| Path | What |
|---|---|
| `src/generate.ts` | Entry point |
| `src/lib/schema.ts`, `text.ts` | Schema flattening, name normalization |
| `src/lib/match.ts` | Candidate scoring, selection, scoping edges |
| `src/lib/llm.ts` | LLM verification, retries, cache |
| `src/lib/service.ts` | Node `service` from tags |
| `src/lib/visualize.ts` | HTML viewer |
| `src/eval.ts`, `eval/` | Evaluation script and labeled sets |
| `dependency_graph.json`, `.html` | Output for `github_catalog.json` |
