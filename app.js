// Thrivea Status — front-end renderer. Reads /api/status.json (refreshed by the
// GitHub Actions monitor) and paints the page. No framework, no build step.

const OVERALL = {
  operational: { label: "All systems operational", cls: "operational", color: "var(--op)" },
  degraded: { label: "Degraded performance", cls: "degraded", color: "var(--deg)" },
  partial_outage: { label: "Partial outage", cls: "partial_outage", color: "var(--down)" },
  major_outage: { label: "Major outage", cls: "major_outage", color: "var(--down)" },
  maintenance: { label: "Under maintenance", cls: "maintenance", color: "var(--maint)" }
};
const COMP = {
  operational: { label: "Operational", color: "var(--op)" },
  degraded: { label: "Degraded", color: "var(--deg)" },
  down: { label: "Outage", color: "var(--down)" }
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) node.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return node;
};

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function fmt(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderOverall(data) {
  const o = OVERALL[data.overall] ?? OVERALL.operational;
  const node = $("#overall");
  node.className = `overall is-${data.overall}`;
  node.replaceChildren(
    el("span", { class: "overall-dot", style: `background:${o.color}` }),
    el("div", {},
      el("h1", {}, o.label),
      el("p", { class: "sub" }, `Updated ${timeAgo(data.generatedAt)}`))
  );
}

function uptimeBars(history) {
  const wrap = el("div", { class: "uptime-bars" });
  const days = history && history.length ? history : Array.from({ length: 90 }, () => ({ uptime: null }));
  for (const d of days) {
    let cls = "none", title = `${d.date ?? ""}: no data`;
    if (d.uptime !== null && d.uptime !== undefined) {
      if (d.down > 0 || d.uptime < 0.95) { cls = "down"; title = `${d.date}: outage`; }
      else if (d.degraded > 0 || d.uptime < 0.999) { cls = "deg"; title = `${d.date}: degraded`; }
      else { cls = "op"; title = `${d.date}: operational`; }
    }
    wrap.append(el("div", { class: `bar ${cls}`, title }));
  }
  return wrap;
}

function renderComponents(data) {
  const root = $("#components");
  root.replaceChildren();
  const groups = data.groups ?? [{ id: null, name: "" }];
  for (const g of groups) {
    const comps = data.components.filter((c) => c.group === g.id);
    if (!comps.length) continue;
    if (g.name) root.append(el("div", { class: "group-title" }, g.name));
    for (const c of comps) {
      const st = COMP[c.status] ?? COMP.operational;
      const pct = c.uptime90 === null || c.uptime90 === undefined ? "—" : `${(c.uptime90 * 100).toFixed(2)}%`;
      root.append(
        el("div", { class: "component", id: `component-${c.id}` },
          el("div", { class: "component-top" },
            el("div", {},
              el("div", { class: "component-name" }, c.name),
              el("p", { class: "component-desc" }, c.description ?? "")),
            el("span", { class: `status-pill c-${c.status}` },
              el("span", { class: "dot", style: `background:${st.color}` }), st.label)),
          el("div", { class: "uptime" },
            uptimeBars(c.history),
            el("div", { class: "uptime-meta" },
              el("span", {}, `${data.site?.historyDays ?? 90} days ago`),
              el("span", {}, `${pct} uptime`),
              el("span", {}, "today"))))
      );
    }
  }
}

function timeline(updates) {
  const ul = el("ul", { class: "timeline" });
  for (const u of updates ?? []) {
    ul.append(el("li", {},
      el("span", { class: "u-status" }, u.status),
      el("span", { class: "u-time" }, fmt(u.at)),
      el("p", { class: "u-body" }, u.body)));
  }
  return ul;
}

function nameFor(data, id) { return data.components.find((c) => c.id === id)?.name ?? id; }

function renderActiveIncidents(data) {
  const root = $("#incidents");
  const list = data.activeIncidents ?? [];
  if (!list.length) { root.hidden = true; root.replaceChildren(); return; }
  root.hidden = false;
  root.replaceChildren();
  for (const i of list) {
    const cls = i.impact === "major" ? "major" : i.impact === "maintenance" ? "maintenance" : "minor";
    const badgeColor = cls === "major" ? "var(--down)" : cls === "maintenance" ? "var(--maint)" : "var(--deg)";
    const card = el("div", { class: `incident-card ${cls}`, id: i.id },
      el("div", { class: "incident-head" },
        el("h3", { class: "incident-title" }, i.title),
        el("span", { class: "badge", style: `background:${badgeColor}` }, i.impact)),
      el("p", { class: "incident-affected" }, "Affected: " + (i.componentIds ?? []).map((c) => nameFor(data, c)).join(", ")));
    if (i.eta) card.append(el("p", { class: "incident-eta" }, `Estimated resolution: ${fmt(i.eta)}`));
    card.append(timeline(i.updates));
    root.append(card);
  }
}

function renderPast(data) {
  const root = $("#pastList");
  root.replaceChildren();
  const resolved = (data.recentIncidents ?? []).filter((i) => i.resolvedAt);
  if (!resolved.length) { root.append(el("p", { class: "past-none" }, "No incidents reported recently. 🎉")); return; }
  const byDay = {};
  for (const i of resolved) {
    const day = new Date(i.startedAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    (byDay[day] ??= []).push(i);
  }
  for (const [day, items] of Object.entries(byDay)) {
    const block = el("div", { class: "past-day" }, el("h3", {}, day));
    for (const i of items) {
      const color = i.impact === "major" ? "var(--down)" : "var(--deg)";
      const mins = Math.round((new Date(i.resolvedAt) - new Date(i.startedAt)) / 60000);
      block.append(el("div", { class: "past-item" },
        el("span", { class: "dot", style: `background:${color}` }),
        el("strong", {}, i.title),
        el("span", { class: "muted" }, ` — resolved in ${mins} min (${fmt(i.startedAt)})`)));
    }
    root.append(block);
  }
}

async function load() {
  try {
    const res = await fetch(`api/status.json?t=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    document.title = `${data.overall === "operational" ? "✅" : "⚠️"} ${data.site?.title ?? "Thrivea Status"}`;
    if (data.site?.brandColor) document.documentElement.style.setProperty("--brand", data.site.brandColor);
    if (data.site?.homeUrl) $("#homeLink").href = data.site.homeUrl;
    if (data.site?.supportEmail) {
      const link = $("#supportLink"); link.href = `mailto:${data.site.supportEmail}`; link.textContent = data.site.supportEmail;
    }
    renderOverall(data);
    renderActiveIncidents(data);
    renderComponents(data);
    renderPast(data);
    $("#updatedAt").textContent = timeAgo(data.generatedAt);
  } catch (err) {
    $("#overall").innerHTML = '<div class="overall-skeleton">Could not load status data.</div>';
    console.error(err);
  }
}

load();
setInterval(load, 60000);
