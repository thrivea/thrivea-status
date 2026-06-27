#!/usr/bin/env node
// Copyright (C) Thrivea d.o.o.
// External uptime monitor for the Thrivea platform status page.
// Pure Node (>=18) — no dependencies. Probes public health endpoints from
// outside Azure, derives per-component status, manages auto-incidents,
// rolls up 90-day uptime history, emits an Atom feed, and notifies on change.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = path.join(ROOT, 'api');
const HISTORY = path.join(API, 'history');

const STATE = { operational: 0, degraded: 1, down: 2 };
const worse = (a, b) => (STATE[a] >= STATE[b] ? a : b);

const now = new Date();
const nowIso = now.toISOString();
const today = nowIso.slice(0, 10); // YYYY-MM-DD
const thisMonth = nowIso.slice(0, 7); // YYYY-MM

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

// --- Probe a single target -------------------------------------------------
async function probe(monitor) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), monitor.timeoutMs ?? 12000);
  try {
    const res = await fetch(monitor.url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Thrivea-Status-Monitor/1.0' }
    });
    const body = await res.text();
    return { reached: true, httpStatus: res.status, latency: Date.now() - started, body };
  } catch (err) {
    return { reached: false, httpStatus: 0, latency: Date.now() - started, body: '', error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Map an ASP.NET health status word to our component state.
const fromHealthWord = (word) => {
  const w = String(word || '').trim().toLowerCase();
  if (w === 'healthy') return 'operational';
  if (w === 'degraded') return 'degraded';
  return 'down';
};

// Evaluate one monitor → { componentId: state, ... }
function evaluate(monitor, result) {
  const out = {};
  const setAll = (ids, state) => ids.forEach((id) => { out[id] = worse(out[id] ?? 'operational', state); });

  if (monitor.kind === 'liveness') {
    setAll(monitor.affects, result.reached && result.httpStatus >= 200 && result.httpStatus < 400 ? 'operational' : 'down');
    return out;
  }

  if (!result.reached) {
    setAll(monitor.affects ?? Object.values(monitor.checkMap ?? {}), 'down');
    return out;
  }

  // Try rich JSON first (works once the backend response-writer diff is live).
  if (monitor.kind === 'health-json' && monitor.checkMap) {
    let json = null;
    try { json = JSON.parse(result.body); } catch { /* plain text — fall through */ }
    if (json && json.entries && typeof json.entries === 'object') {
      for (const [name, entry] of Object.entries(json.entries)) {
        const componentId = monitor.checkMap[name];
        if (!componentId) continue;
        out[componentId] = worse(out[componentId] ?? 'operational', fromHealthWord(entry.status));
      }
      // Any mapped component the payload didn't mention inherits the overall status.
      const overall = fromHealthWord(json.status);
      for (const componentId of new Set(Object.values(monitor.checkMap))) {
        if (!(componentId in out)) out[componentId] = overall;
      }
      return out;
    }
    // Plain text today → only drive the fallback components.
    const state = result.httpStatus === 503 ? 'down' : fromHealthWord(result.body);
    setAll(monitor.fallbackAffects ?? [], state);
    return out;
  }

  // Aggregate text health (`/healthz`).
  let state = result.httpStatus === 503 ? 'down' : fromHealthWord(result.body);
  if (state === 'operational' && monitor.degradedAboveMs && result.latency > monitor.degradedAboveMs) state = 'degraded';
  setAll(monitor.affects ?? [], state);
  return out;
}

// --- Main ------------------------------------------------------------------
const config = await readJson(path.join(ROOT, 'config.json'));
const prevStatus = await readJson(path.join(API, 'status.json'), { components: [] });
const prevById = Object.fromEntries((prevStatus.components ?? []).map((c) => [c.id, c]));

// 1. Run every probe in parallel.
const results = await Promise.all(config.monitors.map(async (m) => ({ m, r: await probe(m) })));
for (const { m, r } of results) {
  console.log(`[${m.id}] reached=${r.reached} http=${r.httpStatus} ${r.latency}ms ${r.error ? '(' + r.error + ')' : ''}`);
}

// 2. Fold probe results into per-component states (worst-of across monitors).
const componentState = {};
const componentLatency = {};
for (const { m, r } of results) {
  const evaluated = evaluate(m, r);
  for (const [id, state] of Object.entries(evaluated)) {
    componentState[id] = worse(componentState[id] ?? 'operational', state);
    if (Number.isFinite(r.latency)) componentLatency[id] = Math.max(componentLatency[id] ?? 0, r.latency);
  }
}

// 3. Build the status snapshot.
const components = config.components.map((c) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  group: c.group,
  status: componentState[c.id] ?? 'operational',
  latencyMs: componentLatency[c.id] ?? null
}));

const worstOverall = components.reduce((acc, c) => worse(acc, c.status), 'operational');
const overall =
  worstOverall === 'down' ? (components.every((c) => c.status === 'down') ? 'major_outage' : 'partial_outage')
  : worstOverall === 'degraded' ? 'degraded'
  : 'operational';

// 4. Roll up uptime history (per component, per day: up/total samples).
const summaryFile = path.join(HISTORY, `${thisMonth}.json`);
const monthSummary = await readJson(summaryFile, {});
for (const c of components) {
  const days = (monthSummary[c.id] ??= {});
  const bucket = (days[today] ??= { up: 0, total: 0, down: 0, degraded: 0 });
  bucket.total += 1;
  if (c.status === 'operational') bucket.up += 1;
  else if (c.status === 'degraded') bucket.degraded += 1;
  else bucket.down += 1;
}
await writeJson(summaryFile, monthSummary);

// 5. Incident management — open/resolve auto-incidents on state transitions.
const incidentsFile = path.join(API, 'incidents.json');
const incidentStore = await readJson(incidentsFile, { incidents: [] });
const incidents = incidentStore.incidents ?? [];
const notifications = [];

const impactOf = (state) => (state === 'down' ? 'major' : state === 'degraded' ? 'minor' : 'none');
const openAutoFor = (id) => incidents.find((i) => i.source === 'auto' && !i.resolvedAt && i.componentIds.includes(id));

for (const c of components) {
  const prev = prevById[c.id]?.status ?? 'operational';
  const open = openAutoFor(c.id);

  if (c.status !== 'operational' && !open) {
    const incident = {
      id: `auto-${c.id}-${now.getTime()}`,
      source: 'auto',
      title: `${c.name} ${c.status === 'down' ? 'outage' : 'degraded performance'}`,
      impact: impactOf(c.status),
      componentIds: [c.id],
      status: 'investigating',
      startedAt: nowIso,
      resolvedAt: null,
      eta: null,
      updates: [{ at: nowIso, status: 'investigating', body: `Automated monitoring detected that ${c.name} is ${c.status === 'down' ? 'unreachable / failing health checks' : 'responding slowly or partially'}. Our team has been alerted.` }]
    };
    incidents.unshift(incident);
    notifications.push({ kind: 'opened', incident });
  } else if (c.status === 'operational' && open) {
    open.status = 'resolved';
    open.resolvedAt = nowIso;
    open.updates.unshift({ at: nowIso, status: 'resolved', body: `${c.name} has recovered and is fully operational again. Automated monitoring confirms healthy responses.` });
    notifications.push({ kind: 'resolved', incident: open });
  } else if (c.status !== 'operational' && open && impactOf(c.status) !== open.impact) {
    open.impact = impactOf(c.status);
    open.updates.unshift({ at: nowIso, status: open.status, body: `Impact updated: ${c.name} is now ${c.status}.` });
  }
}

// Keep manual incidents from /incidents/*.json merged in (untouched by automation).
const manualDir = path.join(ROOT, 'incidents');
let manual = [];
try {
  const files = (await fs.readdir(manualDir)).filter((f) => f.endsWith('.json'));
  manual = await Promise.all(files.map((f) => readJson(path.join(manualDir, f), null)));
  manual = manual.filter(Boolean).map((m) => ({ source: 'manual', resolvedAt: null, eta: null, updates: [], ...m }));
} catch { /* no manual incidents */ }

const allIncidents = [...incidents.filter((i) => i.source === 'auto'), ...manual]
  .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

// Prune fully-resolved auto-incidents older than the history window.
const cutoff = new Date(now.getTime() - (config.site.recentIncidentDays ?? 15) * 864e5).toISOString();
incidentStore.incidents = allIncidents.filter((i) => !i.resolvedAt || i.resolvedAt >= cutoff || i.source === 'manual');
await writeJson(incidentsFile, incidentStore);

// 6. Compute rolling uptime % per component over the history window.
const historyDays = config.site.historyDays ?? 90;
const months = [...new Set(Array.from({ length: 4 }, (_, k) => new Date(now.getTime() - k * 28 * 864e5).toISOString().slice(0, 7)))];
const monthly = {};
for (const m of months) monthly[m] = await readJson(path.join(HISTORY, `${m}.json`), {});

function dailyBars(componentId) {
  const bars = [];
  for (let k = historyDays - 1; k >= 0; k--) {
    const d = new Date(now.getTime() - k * 864e5).toISOString().slice(0, 10);
    const m = d.slice(0, 7);
    const bucket = monthly[m]?.[componentId]?.[d];
    if (!bucket || !bucket.total) { bars.push({ date: d, uptime: null }); continue; }
    bars.push({ date: d, uptime: bucket.up / bucket.total, down: bucket.down, degraded: bucket.degraded });
  }
  return bars;
}

function uptimePct(bars) {
  const seen = bars.filter((b) => b.uptime !== null);
  if (!seen.length) return null;
  return seen.reduce((s, b) => s + b.uptime, 0) / seen.length;
}

const componentsOut = components.map((c) => {
  const bars = dailyBars(c.id);
  return { ...c, history: bars, uptime90: uptimePct(bars) };
});

// 7. Write the public snapshot the site reads.
await writeJson(path.join(API, 'status.json'), {
  generatedAt: nowIso,
  overall,
  groups: config.groups,
  site: config.site,
  components: componentsOut,
  activeIncidents: incidentStore.incidents.filter((i) => !i.resolvedAt),
  recentIncidents: incidentStore.incidents.slice(0, 50)
});

// 8. Emit an Atom feed (clients/Slack/Teams can subscribe — $0).
const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
const entries = incidentStore.incidents.slice(0, 25).map((i) => {
  const updated = i.updates?.[0]?.at ?? i.startedAt;
  const body = (i.updates ?? []).map((u) => `<p><strong>${esc(u.status)}</strong> — ${esc(u.body)}</p>`).join('');
  return `  <entry>
    <id>tag:status.thrivea.com,2026:${esc(i.id)}</id>
    <title>${esc(i.title)}${i.resolvedAt ? ' (resolved)' : ''}</title>
    <updated>${updated}</updated>
    <link href="${config.site.url}/#${esc(i.id)}"/>
    <content type="html">${esc(body)}</content>
  </entry>`;
}).join('\n');
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(config.site.title)} — Incidents</title>
  <link href="${config.site.url}/feed.xml" rel="self"/>
  <link href="${config.site.url}"/>
  <id>${config.site.url}/</id>
  <updated>${nowIso}</updated>
${entries}
</feed>
`;
await fs.writeFile(path.join(API, 'feed.xml'), atom);

// 9. Notify on change (Slack / Teams incoming webhooks).
async function notify() {
  if (!notifications.length) return;
  const lines = notifications.map((n) => {
    const i = n.incident;
    const emoji = n.kind === 'resolved' ? '✅' : i.impact === 'major' ? '🔴' : '🟠';
    return `${emoji} *${i.title}* ${n.kind === 'resolved' ? 'resolved' : 'started'} — ${i.updates[0].body}`;
  });
  const text = `*Thrivea Status update*\n${lines.join('\n')}\n${config.site.url}`;

  const slack = process.env[config.notify?.slackWebhookEnv ?? ''];
  const teams = process.env[config.notify?.teamsWebhookEnv ?? ''];
  const posts = [];
  if (slack) posts.push(fetch(slack, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }));
  if (teams) posts.push(fetch(teams, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.replace(/\*/g, '**') }) }));
  await Promise.allSettled(posts);
}
await notify();

console.log(`overall=${overall} incidents(active)=${incidentStore.incidents.filter((i) => !i.resolvedAt).length} notifications=${notifications.length}`);
