// Console de suivi Clevoa : script de la page, servi à part (CSP sans 'unsafe-inline' pour les scripts).
const LABELS = { salesforce: "Salesforce", sagex3: "Sage X3", sharepoint: "SharePoint", dropbox: "Dropbox", myreport: "MyReport" };
const COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5"];
const STATUS = { ok: "OK", incident: "Incident", silencieuse: "Silencieuse", perdue: "Perdue" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("fr-FR"));
const pct = (r) => (r == null ? "–" : `${(r * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`);
const ms = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s` : `${v} ms`);
function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return "il y a moins d'une heure";
  if (h < 48) return `il y a ${Math.round(h)} h`;
  return `il y a ${Math.round(h / 24)} jours`;
}
const sysErr = (s) => Object.entries(s.errors).filter(([t]) => t !== "user").reduce((n, [, v]) => n + v, 0);

let data, selected;
async function load() {
  try {
    const r = await fetch("/api/installations");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    data = await r.json();
  } catch (e) { $("error").hidden = false; $("error").textContent = `Lecture impossible : ${e.message}`; $("meta").textContent = ""; return; }
  $("error").hidden = true;
  $("demo").hidden = !data.demo;
  $("meta").textContent = `Mis à jour ${new Date(data.generatedAt).toLocaleString("fr-FR")} · silence au-delà de ${data.silenceHours} h`;
  const list = data.installations;
  const count = (st) => list.filter((i) => i.status === st).length;
  const tiles = [["Installations suivies", list.filter((i) => i.status !== "perdue").length], ["En incident", count("incident"), count("incident") > 0],
    ["Silencieuses", count("silencieuse"), count("silencieuse") > 0], ["Sièges", list.filter((i) => i.status !== "perdue").reduce((n, i) => n + (i.seats || 0), 0)],
    ["Appels (dernière période)", list.reduce((n, i) => n + (i.calls || 0), 0)]];
  $("tiles").innerHTML = tiles.map(([l, v, a]) => `<div class="tile${a ? " alert" : ""}"><span class="v">${fmt(v)}</span><span class="l">${esc(l)}</span></div>`).join("");
  $("rows").innerHTML = list.length ? list.map((i, n) => `<tr tabindex="0" data-n="${n}"${i.pk === selected ? ' class="sel"' : ""}>
    <td><span class="chip ${i.status}">${STATUS[i.status]}</span></td><td><b>${esc(i.client)}</b></td><td>${esc(i.env)}</td>
    <td>${esc(i.version)}${i.outdated ? '<span class="old">ancienne</span>' : ""}</td><td title="${esc(i.lastSeen)}">${ago(i.lastSeen)}</td>
    <td class="num">${fmt(i.seats)}</td><td class="num">${fmt(i.calls)}</td><td class="num">${pct(i.errorRate)}</td><td class="num">${ms(i.p95)}</td></tr>`).join("")
    : '<tr><td colspan="9" class="empty">Aucune installation n\'a encore envoyé de télémétrie.</td></tr>';
  for (const tr of $("rows").querySelectorAll("tr[data-n]")) {
    const open = () => show(list[tr.dataset.n]);
    tr.addEventListener("click", open); tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
  const first = list.find((i) => i.pk === selected) || list.find((i) => i.status === "incident") || list[0];
  if (first) show(first);
}

// ---------- Graphes SVG : abscisse en temps sur 30 jours (une période absente ou un silence laisse un trou), une échelle par graphe ----------
const W = 640, H = 220, M = { l: 52, r: 12, t: 10, b: 28 };
const DAYS = 30, SLOT = 6 * 3600_000;
const color = (v) => `var(${v})`;
function axes(maxY, unit, [t0, t1]) {
  const ticks = niceTicks(maxY); const top = ticks.at(-1) || 1;
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / top);
  const x = (t) => M.l + ((W - M.l - M.r) * (t - t0)) / (t1 - t0);
  let g = ticks.map((t) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${M.l - 6}" y="${y(t) + 4}" text-anchor="end">${unit(t)}</text>`).join("");
  for (let k = 0; k <= 5; k++) { const t = t0 + ((t1 - t0) * (k + 0.5)) / 6; g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}</text>`; }
  return { g, x, y, top, slot: ((W - M.l - M.r) * SLOT) / (t1 - t0) };
}
const end = (p) => Date.parse(p.at), start = (p) => (p.since ? Date.parse(p.since) : end(p) - SLOT);
function niceTicks(max) {
  if (!max || max <= 0) return [0, 1];
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = []; for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toFixed(6)); return out;
}
const svg = (inner, label) => `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${inner}</svg>`;

function bars(periods, dom) {
  const parts = periods.map((p) => { const all = Object.values(p.stats); const calls = all.reduce((n, s) => n + s.calls, 0), sys = all.reduce((n, s) => n + sysErr(s), 0), usr = all.reduce((n, s) => n + s.errors.user, 0); return { ok: calls - sys - usr, sys, usr, calls }; });
  const a = axes(Math.max(...parts.map((p) => p.calls), 1), fmt, dom);
  const bw = Math.max(1, a.slot * 0.75);
  let g = a.g;
  parts.forEach((p, i) => {
    const cx = a.x(end(periods[i]) - SLOT / 2); let base = 0;
    for (const [v, c] of [[p.ok, "--c1"], [p.sys, "--bad"], [p.usr, "--warn"]]) { if (!v) continue; const y0 = a.y(base), y1 = a.y(base + v); g += `<rect x="${cx - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(0.5, y0 - y1)}" fill="${color(c)}"><title>${new Date(end(periods[i])).toLocaleString("fr-FR")} : ${fmt(p.calls)} appels, ${fmt(p.sys)} erreurs système</title></rect>`; base += v; }
  });
  return svg(g, "Appels par période");
}
function lines(periods, value, unit, label, legendId, dom) {
  const names = [...new Set(periods.flatMap((p) => Object.keys(p.stats)))];
  const series = names.map((c) => periods.map((p) => (p.stats[c] && p.stats[c].calls ? value(p.stats[c]) : null)));
  const a = axes(Math.max(...series.flat().filter((v) => v != null), 0), unit, dom);
  let g = a.g;
  names.forEach((c, k) => {
    const col = color(COLORS[k % COLORS.length]);
    let d = "", prev = null; // trait interrompu par une période sans appel ou par un trou de plus d'une période (silence)
    series[k].forEach((v, i) => {
      if (v == null) { prev = null; return; }
      const t = end(periods[i]);
      d += `${prev != null && start(periods[i]) - prev <= SLOT / 2 ? "L" : "M"}${a.x(t - SLOT / 2).toFixed(1)},${a.y(v).toFixed(1)}`;
      prev = t;
    });
    g += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lastI = series[k].findLastIndex((v) => v != null);
    if (lastI >= 0) g += `<circle cx="${a.x(end(periods[lastI]) - SLOT / 2)}" cy="${a.y(series[k][lastI])}" r="3.5" fill="${col}"><title>${esc(LABELS[c] || c)} : ${esc(unit(series[k][lastI]))}</title></circle>`;
  });
  $(legendId).innerHTML = names.map((c, k) => `<span><i style="background:${color(COLORS[k % COLORS.length])}"></i>${esc(LABELS[c] || c)}</span>`).join("");
  return svg(g, label);
}

let shown = 0; // numéro du dernier affichage demandé : une réponse plus ancienne est ignorée
async function show(i) {
  const n = ++shown;
  selected = i.pk;
  for (const tr of $("rows").querySelectorAll("tr[data-n]")) tr.classList.toggle("sel", data.installations[tr.dataset.n].pk === i.pk);
  $("detail").hidden = false;
  $("d-title").textContent = `${i.client} · ${i.env}`;
  $("d-sub").textContent = `version ${i.version} · suivie depuis le ${i.firstSeen ? new Date(i.firstSeen).toLocaleDateString("fr-FR") : "?"} · dernier contact le ${new Date(i.lastSeen).toLocaleString("fr-FR")}`;
  $("d-incidents").innerHTML = i.incidents.map((t) => `<div>${esc(t)}</div>`).join("");
  const empty = (text) => { for (const id of ["c-calls", "c-rate", "c-lat"]) $(id).innerHTML = `<div class="empty">${esc(text)}</div>`; for (const id of ["l-rate", "l-lat", "d-table"]) $(id).innerHTML = ""; };
  let periods;
  try {
    const r = await fetch(`/api/history?pk=${encodeURIComponent(i.pk)}&days=${DAYS}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ({ periods } = await r.json());
  } catch (e) { if (n === shown) empty(`Historique illisible : ${e.message}`); return; }
  if (n !== shown) return; // une autre installation a été choisie entre-temps
  const withStats = periods.filter((p) => Object.keys(p.stats).length);
  if (!withStats.length) return empty("Pas encore de statistiques (hub antérieur à 1.3.2-rc.2, ou aucun appel).");
  const dom = [Date.now() - DAYS * 86400_000, Date.now()];
  $("c-calls").innerHTML = bars(withStats, dom);
  $("c-rate").innerHTML = lines(periods, (s) => sysErr(s) / s.calls, (v) => `${Math.round(v * 100)} %`, "Taux d'erreur", "l-rate", dom);
  $("c-lat").innerHTML = lines(periods, (s) => s.p95, ms, "Latence p95", "l-lat", dom);
  const tot = Object.create(null);
  for (const p of withStats) for (const [c, s] of Object.entries(p.stats)) { const t = (tot[c] ||= { calls: 0, err: 0, p50: [], p95: [] }); t.calls += s.calls; t.err += sysErr(s); t.p50.push(s.p50); t.p95.push(s.p95); }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  $("d-table").innerHTML = Object.entries(tot).map(([c, t]) => `<tr><td>${esc(LABELS[c] || c)}</td><td class="num">${fmt(t.calls)}</td><td class="num">${pct(t.calls ? t.err / t.calls : null)}</td><td class="num">${ms(median(t.p50))}</td><td class="num">${ms(median(t.p95))}</td></tr>`).join("");
}
load();
setInterval(load, 5 * 60 * 1000); // rafraîchie toutes les 5 minutes
