# Thrivea Status

A **self-hosted, $0, fully independent** status page for the Thrivea platform.

- **Independent of Azure** — runs entirely on GitHub Actions (monitoring) + GitHub Pages (hosting). When Thrivea/Azure is down, this page stays up, because it lives on GitHub's infrastructure.
- **Auto-reporting** — a cron job probes the public health endpoints every 5 minutes from outside Azure, derives per-component status, and **auto-opens / auto-resolves incidents** on state change.
- **$0** — public GitHub repo ⇒ unlimited Actions minutes; Pages hosting + custom domain + HTTPS are free.
- **Custom domain** — `status.thrivea.com`.

```
GitHub Actions (cron */5)  ──probes──▶  app-thrivea-prod /healthz, /healthz/all, /admin/host/ping
        │  derive status, manage incidents, roll up 90-day uptime, emit feed.xml
        ▼  commit api/*.json
GitHub Pages (status.thrivea.com)  ──serves──▶  static site reads api/status.json
```

## What clients see

A single banner (All systems operational / Degraded / Partial outage / Major outage), a per-service component list (Application API, Authentication & SSO, Social Feed, HR & Organization, Notifications & Email, Database, Background Jobs) each with a 90-day uptime bar, active incidents with a timeline + ETA, and a past-incidents history. Clients can subscribe via the Atom/RSS feed (`/api/feed.xml`).

---

## One-time setup (≈15 min)

### 1. Create the repo (public — required for free unlimited Actions)
```bash
cd thrivea-status
git init && git add -A && git commit -m "feat: Thrivea status page"
gh repo create thrivea/thrivea-status --public --source=. --push
```

### 2. Enable GitHub Pages
Repo → **Settings → Pages** → Source = **Deploy from a branch** → Branch = `main` / `/ (root)` → Save.

### 3. Point the custom domain  (do this once you have GoDaddy access)
Until then the site is live and previewable at `https://thrivea.github.io/thrivea-status/`. The repo ships `CNAME.pending` (not active) so the github.io URL keeps working.

When ready, at GoDaddy (where `thrivea.com` is hosted) add:

```
CNAME   status   thrivea.github.io.
```

Then in **Settings → Pages → Custom domain** enter `status.thrivea.com` and Save (this writes the real `CNAME` file for you), and tick **Enforce HTTPS**. You can delete `CNAME.pending` afterwards.

### 4. Confirm the monitored host  ⚠️ the one thing to verify
`config.json` currently probes `https://app-thrivea-prod.azurewebsites.net` (the Azure default host, which always resolves). If the prod App service has access restrictions, or you prefer the pretty domain, replace the three `monitors[].url` hosts with the **publicly reachable** prod host (e.g. `https://api.thrivea.com`). Verify first:

```bash
curl -i https://app-thrivea-prod.azurewebsites.net/admin/host/ping
curl -i https://app-thrivea-prod.azurewebsites.net/healthz
```

### 5. (Optional) Notifications
Add repo secrets to push alerts to chat on every incident open/resolve:
- `SLACK_WEBHOOK_URL` — a Slack Incoming Webhook
- `TEAMS_WEBHOOK_URL` — a Microsoft Teams Incoming Webhook

### 6. Kick the first run
Repo → **Actions → uptime → Run workflow**. After it commits, the page is live.

---

## Unlock true per-service granularity (small backend diff)

Today `/healthz` returns plain text (`Healthy`/`Unhealthy`), so the monitor can only see the app's **aggregate** health — all core components move together. To light up **Auth / Networking / Organization / Notifications / Database independently**, add a JSON response writer to `/healthz/all` in
`src/App/Thrivea.App.Host/Program.cs`:

```csharp
app.MapHealthChecks("/healthz/all", new HealthCheckOptions
{
    ResponseWriter = async (ctx, report) =>
    {
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsJsonAsync(new
        {
            status = report.Status.ToString(),
            entries = report.Entries.ToDictionary(
                e => e.Key,
                e => new { status = e.Value.Status.ToString() })
        });
    }
}).AllowAnonymous();
```

No new NuGet dependency, no behavior change for k8s/probes. The monitor already parses this shape (`config.json → monitors[].checkMap` maps each health-check name to a component) and will switch from aggregate to per-component automatically the moment it goes live. The exposed check names are generic (`postgres-db`, `init-auth-data-source-pool`, …) — rename in the writer if you'd rather not expose them.

---

## Posting incidents

- **Automatic** — the monitor opens an incident when a component goes unhealthy and resolves it on recovery. Nothing to do.
- **Manual / planned maintenance / ETA** — copy `incidents/TEMPLATE.json.example` to a real `incidents/<name>.json`, fill it in, push. See the template for the schema. ETAs ("kad će biti popravljeno") are human input — set the `eta` field and post `updates`.

## Local preview
```bash
node scripts/monitor.mjs      # run one probe cycle, writes api/*.json
python3 -m http.server 8000   # then open http://localhost:8000
```

## Dedicated / isolated environments
Dedicated single-tenant deployments are intentionally **not** on this public page — they expect a private/separate status surface. Spin up a second instance of this repo (its own repo + domain) for those, or add another group in `config.json` only if that tenant is fine being listed publicly.
