/**
 * Self-contained HTML viewer for the graph (vis-network from a CDN, data inlined).
 * Scoping edges (owner/repo-like params that nearly every tool needs) are hidden by
 * default so the interesting id dependencies stay readable; a toggle brings them back.
 */
interface VNode { id: string; service?: string }
interface VEdge { from: string; to: string; label?: string; context?: boolean }

export function renderHTML(graph: { nodes: VNode[]; edges: VEdge[] }, title: string): string {
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} dependency graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  :root { --bg:#fbfaf7; --panel:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e4e2dc; --accent:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --panel:#1e1e1c; --ink:#ecebe6; --muted:#9a998f; --line:#34332f; --accent:#fb923c; } }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); display:flex; height:100vh; }
  aside { width:340px; flex:none; border-right:1px solid var(--line); background:var(--panel); padding:16px; overflow:auto; }
  main { flex:1; position:relative; }
  #net { position:absolute; inset:0; }
  h1 { font-size:16px; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:12px; }
  label { display:block; margin:10px 0 4px; font-size:12px; color:var(--muted); }
  input[type=text], select { width:100%; padding:7px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; }
  .row { display:flex; gap:8px; align-items:center; margin-top:8px; font-size:13px; }
  #detail h2 { font-size:13px; margin:16px 0 6px; word-break:break-all; }
  #detail ul { margin:0; padding-left:16px; }
  #detail li { margin:2px 0; word-break:break-all; font-size:12px; cursor:pointer; }
  code { font-size:11px; background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
  button { margin-top:10px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); cursor:pointer; }
  @media (max-width: 700px) { body { flex-direction:column; } aside { width:auto; height:45vh; border-right:0; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<aside>
  <h1>${title} tool dependencies</h1>
  <div class="muted" id="stats"></div>
  <label for="search">Find a tool</label>
  <input id="search" type="text" list="slugs" placeholder="e.g. MERGE_A_PULL_REQUEST">
  <datalist id="slugs"></datalist>
  <label for="service">Service</label>
  <select id="service"><option value="">All services</option></select>
  <div class="row"><input type="checkbox" id="ctx"><span>Show scoping edges (owner, repo, org…)</span></div>
  <div class="row"><input type="checkbox" id="iso"><span>Show tools with no edges</span></div>
  <div class="row"><input type="checkbox" id="focus" checked><span>Focus on selection (2 hops up, 1 down)</span></div>
  <button id="reset">Reset view</button>
  <div id="detail"><p class="muted">Click a tool to see what it needs and what it unlocks. Edges point producer → consumer, labeled with the value passed.</p></div>
</aside>
<main><div id="net"></div></main>
<script>
const G = ${data};
const $ = (id) => document.getElementById(id);
const services = [...new Set(G.nodes.map(n => n.service || "other"))].sort();
const palette = ["#2563eb","#c2410c","#059669","#7c3aed","#db2777","#0891b2","#ca8a04","#4b5563","#dc2626","#16a34a","#9333ea","#0d9488","#ea580c","#4f46e5","#be123c","#65a30d"];
const color = Object.fromEntries(services.map((s, i) => [s, palette[i % palette.length]]));
services.forEach(s => $("service").insertAdjacentHTML("beforeend", '<option value="' + s + '">' + s + '</option>'));
G.nodes.forEach(n => $("slugs").insertAdjacentHTML("beforeend", '<option value="' + n.id + '">'));
const short = (id) => id.replace(/^[A-Z0-9]+_/, "");
const inE = {}, outE = {};
G.edges.forEach(e => { (inE[e.to] ||= []).push(e); (outE[e.from] ||= []).push(e); });

let selected = null;
const nodesDS = new vis.DataSet(), edgesDS = new vis.DataSet();
const net = new vis.Network($("net"), { nodes: nodesDS, edges: edgesDS }, {
  nodes: { shape: "dot", size: 8, font: { size: 11, color: getComputedStyle(document.body).color } },
  edges: { arrows: { to: { enabled: true, scaleFactor: 0.4 } }, color: { opacity: 0.45 }, font: { size: 9, align: "middle", strokeWidth: 0, color: "#888" }, smooth: false },
  physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -40, springLength: 90 }, stabilization: { iterations: 250 } },
  interaction: { hover: true, tooltipDelay: 120 },
});

function visible() {
  const ctx = $("ctx").checked, iso = $("iso").checked, svc = $("service").value;
  let edges = G.edges.filter(e => ctx || !e.context);
  let keep;
  if (selected && $("focus").checked) {
    keep = new Set([selected]);
    let frontier = [selected];
    for (let d = 0; d < 2; d++) { const nx = []; frontier.forEach(id => (inE[id] || []).forEach(e => { if ((ctx || !e.context) && !keep.has(e.from)) { keep.add(e.from); nx.push(e.from); } })); frontier = nx; }
    (outE[selected] || []).forEach(e => { if (ctx || !e.context) keep.add(e.to); });
    edges = edges.filter(e => keep.has(e.from) && keep.has(e.to) && (e.to === selected || e.from === selected || keep.has(e.to)));
  } else {
    if (svc) { const ids = new Set(G.nodes.filter(n => (n.service || "other") === svc).map(n => n.id)); edges = edges.filter(e => ids.has(e.from) || ids.has(e.to)); }
    keep = new Set(edges.flatMap(e => [e.from, e.to]));
    if (iso) G.nodes.forEach(n => (!svc || n.service === svc) && keep.add(n.id));
  }
  return { nodes: G.nodes.filter(n => keep.has(n.id)), edges };
}

function render() {
  const v = visible();
  const showLabels = v.edges.length < 150;
  nodesDS.clear(); edgesDS.clear();
  nodesDS.add(v.nodes.map(n => ({ id: n.id, label: short(n.id), title: n.id + "\\nservice: " + (n.service || "other"),
    color: n.id === selected ? "${"#111"}" : color[n.service || "other"], size: n.id === selected ? 16 : 8 })));
  edgesDS.add(v.edges.map((e, i) => ({ id: i, from: e.from, to: e.to, label: showLabels ? e.label : undefined, title: e.label, dashes: !!e.context })));
  $("stats").textContent = G.nodes.length + " tools · " + G.edges.length + " edges · showing " + v.nodes.length + " / " + v.edges.length;
}

function detail(id) {
  const need = {}; (inE[id] || []).forEach(e => (need[e.label] ||= []).push(e.from));
  const unlocks = (outE[id] || []).filter(e => !e.context);
  const li = (s, extra) => '<li data-id="' + s + '">' + short(s) + (extra ? ' <code>' + extra + '</code>' : '') + '</li>';
  let h = '<h2>' + id + '</h2><div class="muted">service: ' + (G.nodes.find(n => n.id === id)?.service || "other") + '</div>';
  const labels = Object.keys(need);
  h += '<h2>Needs (' + labels.length + ' inputs with known sources)</h2>';
  h += labels.length ? labels.map(l => '<div><code>' + l + '</code> from:<ul>' + need[l].map(s => li(s)).join("") + '</ul></div>').join("") : '<p class="muted">Nothing upstream — all inputs come from the user.</p>';
  h += '<h2>Unlocks (' + unlocks.length + ')</h2><ul>' + unlocks.slice(0, 60).map(e => li(e.to, e.label)).join("") + '</ul>';
  $("detail").innerHTML = h;
  $("detail").querySelectorAll("li[data-id]").forEach(el => el.onclick = () => select(el.dataset.id));
}

function select(id) { selected = id; $("search").value = id; detail(id); render(); net.once("stabilized", () => net.focus(id, { scale: 1, animation: true })); }
net.on("click", p => p.nodes.length && select(p.nodes[0]));
$("search").addEventListener("change", e => G.nodes.some(n => n.id === e.target.value) && select(e.target.value));
["ctx", "iso", "focus", "service"].forEach(id => $(id).addEventListener("change", render));
$("reset").onclick = () => { selected = null; $("search").value = ""; $("detail").innerHTML = ""; render(); };
render();
</script>
</body>
</html>
`;
}
