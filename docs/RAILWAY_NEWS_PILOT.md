# OSIRIS: Railway + Vercel news integration (preview pilot)

## Current topology (27 November 2026)

- **Vercel**: Next.js UI and APIs. Production stays unchanged by this pilot.
- **Railway**: existing production service `osiris` runs container
  `ghcr.io/simplifaisoul/osiris:latest`, one replica (sfo).
- **Railway `martin`**: image staged for creation, **not deployed**.
  Do not apply unrelated production environment changes as part of the pilot.
- **No shared database, queue, or persistent Railway volume** was present
  during the infrastructure inspection.

A Railway process-health response (`/api/health`) confirms only that its
Next.js server is answering. It does *not* establish that RSS/Telegram feeds
or background jobs are healthy. The Railway container image may be at a
different revision from the Vercel/GitHub branch.

## Opt-in switch

Set `OSIRIS_NEWS_BACKEND=railway` in **Vercel Preview only** for
`fix/openfreemap`. Production and other environments have no opt-in
flag and retain their previous local news collection.

When enabled, `/api/news` tries the fixed HTTPS Railway OSIRIS
`/api/news` endpoint. It accepts the response only if it is timely,
schema-compatible and non-misleading. On failure, the route uses the
existing local aggregator; errors never replace a valid source with fake
news or zeroes. Failure cooldown is one minute per running process.

To diagnose one instance:
- `GET /api/integration/railway` — `mode`, Railway process availability;
  does **not** test upstream source freshness
- `GET /api/news` — normal feed, `X-Osiris-News-Origin` response header:
  `railway` or `local`

Security properties:
- Remote host is a fixed allowlisted Railway service; never a user URL.
- No Vercel session cookies or authorization credentials are sent to Railway.
- No redirects, a 7s deadline, response-size and schema checks.
- No secrets in GitHub; preview feature flag stores no credential.

## Important limitations

This is a **routing and failover pilot**, not a continuous 24/7 collector
or durable store. Railway currently builds its `/api/news` feed on demand.
Vercel/Railway memory caches are per-process, not shared. A true
background collector requires an explicit Railway worker or cron
plus durable storage (e.g. managed Postgres/Redis), defined retention,
service authentication, metrics, and cost review. None has been
provisioned yet.

## Release gates

1. Confirm the preview Vercel deployment includes the scoped env flag.
2. Check `/api/integration/railway`: `railway.reachable=true` indicates
   process liveness only.
3. Request `/api/news`: verify `X-Osiris-News-Origin`, timestamp,
   source health, titles, deduplication and Android display. Forcing an
   unreachable upstream must result in `local` (not a blank feed).
4. Run `npx vitest run src/lib/railway-news.test.ts` and type-check.
5. Only after successful real-data testing should production routing be
   enabled by adding the flag to production; do not automatically change
   the Railway production service or apply the unrelated staged Martin service.
