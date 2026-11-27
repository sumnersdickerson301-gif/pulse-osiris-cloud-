import { NextResponse } from 'next/server';

export const maxDuration = 60;

/**
 * OSIRIS — Global Stats API
 * Lightweight aggregation endpoint.
 * Fetches metrics from all local APIs and returns ONLY the counts.
 *
 * ARCHITECTURE NOTE (10k+ Concurrent Users):
 * This endpoint ensures the Next.js server serves ~100 bytes instead of 10MB+
 * of raw GeoJSON mapping data when 10,000 users boot the dashboard simultaneously.
 * The underlying API routes utilize their own 45-60s TTL caching, meaning the
 * heavy external APIs (adsb.lol, USGS) are only hit once per minute, while this
 * lightweight stats route safely serves 10k concurrent users instantly.
 */

type Stats = { flights: number; sats: number; cctv: number; weather: number; nuclear: number; incidents: number };
type Snapshot = { stats: Stats; timestamp: string; at: number };
const EMPTY: Stats = { flights: 0, sats: 0, cctv: 0, weather: 0, nuclear: 0, incidents: 0 };

/* One computation serves everyone. Each one pulls six of this app's own feeds —
   CCTV alone is ~5MB — and parses them only to count. The per-fetch
   `revalidate` hints never helped: Next's data cache refuses anything over 2MB,
   so the two largest feeds were refetched in full on every call, and
   Cloudflare does not cache /api responses either. Every arriving visitor paid
   for all six, and under production load the endpoint took 15-19s to return
   ~100 bytes. Now there is at most one computation per TTL, concurrent callers
   share it, and a stale snapshot answers instantly while a fresh one is
   computed behind it. */
const TTL_MS = 30_000;
let snapshot: Snapshot | undefined;
let inflight: Promise<Snapshot> | undefined;

/** Test hook, mirroring clearMaritimeSnapshot. */
export function clearStatsSnapshot() {
  snapshot = undefined;
  inflight = undefined;
}

/** A protected Vercel route may return an HTML login page with HTTP 200.
 * Treat this as a failed feed, not JSON; preserve counts from healthy feeds.
 */
async function readStatsJson(result: PromiseSettledResult<Response>, route: string): Promise<Record<string, unknown> | null> {
  if (result.status !== 'fulfilled') return null;
  const response = result.value;
  if (!response.ok) return null;
  const mime = response.headers.get('content-type') ?? '';
  if (mime && !mime.toLowerCase().includes('application/json') && !mime.toLowerCase().includes('+json')) {
    console.warn('[OSIRIS] stats ignored non-JSON response from /api/' + route + ' (' + mime.slice(0, 60) + ')');
    return null;
  }
  try {
    const value: unknown = await response.json();
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    console.warn('[OSIRIS] stats ignored malformed JSON from /api/' + route);
  }
  return null;
}

function countArray(record: Record<string, unknown> | null, key: string): number | null {
  if (!record || !Array.isArray(record[key])) return null;
  return (record[key] as unknown[]).length;
}

/** Counts for the feeds that answered; a feed that failed is simply absent.
 * Vercel SSO protects the project's own /api routes. Server-side fetch() has
 * no browser cookie jar, so an unauthenticated self-fetch is redirected to the
 * Vercel login HTML. Forward only the incoming SAME-ORIGIN session cookie.
 * This does not bypass protection or send credentials to a third party.
 */
async function computeStats(origin: string, sessionCookie: string | null): Promise<Partial<Stats>> {
  const headers: HeadersInit = { Accept: 'application/json' };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const routes = ['flights', 'satellites', 'cctv', 'weather', 'infrastructure', 'gdelt'];
  const results = await Promise.allSettled(routes.map(route =>
    fetch(`${origin}/api/${route}`, {
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
      headers,
    })
  ));
  const [flightsRes, satsRes, cctvRes, weatherRes, infraRes, gdeltRes] = results;

  const fresh: Partial<Stats> = {};

  // A bad feed cannot spoil the counts returned by the other five.
  const [flights, satellites, cctv, weather, infrastructure, gdelt] = await Promise.all([
    readStatsJson(flightsRes, 'flights'),
    readStatsJson(satsRes, 'satellites'),
    readStatsJson(cctvRes, 'cctv'),
    readStatsJson(weatherRes, 'weather'),
    readStatsJson(infraRes, 'infrastructure'),
    readStatsJson(gdeltRes, 'gdelt'),
  ]);

  if (flights) {
    const fields = ['commercial_flights', 'private_flights', 'private_jets', 'military_flights'];
    const sizes = fields.map(key => countArray(flights, key));
    if (sizes.some(size => size !== null)) fresh.flights = sizes.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  const satsCount = countArray(satellites, 'satellites');
  if (satsCount !== null) fresh.sats = satsCount;
  const cameraCount = countArray(cctv, 'cameras');
  if (cameraCount !== null) fresh.cctv = cameraCount;
  const weatherCount = countArray(weather, 'events');
  if (weatherCount !== null) fresh.weather = weatherCount;
  const nuclearCount = countArray(infrastructure, 'infrastructure');
  if (nuclearCount !== null) fresh.nuclear = nuclearCount;
  const incidentCount = countArray(gdelt, 'events');
  if (incidentCount !== null) fresh.incidents = incidentCount;

  // Do not present six invented zeros as a valid new snapshot when Vercel SSO
  // intercepted every self-fetch or every upstream returned an error.
  if (Object.keys(fresh).length === 0) throw new Error('No valid JSON stats sources responded');

  return fresh;
}

function refresh(origin: string, sessionCookie: string | null) {
  inflight ??= computeStats(origin, sessionCookie)
    .then(fresh => {
      /* A feed that failed keeps its last good count instead of dropping to
         zero, and a computation that reached nothing does not count as fresh.
         Caching is what makes this matter: without it, a transient failure
         showed zeros to one request; with it, the same failure would be
         pinned for a whole TTL. */
      const reached = Object.keys(fresh).length > 0;
      const next: Snapshot = {
        stats: { ...EMPTY, ...snapshot?.stats, ...fresh },
        timestamp: reached || !snapshot ? new Date().toISOString() : snapshot.timestamp,
        at: reached ? Date.now() : snapshot?.at ?? 0,
      };
      snapshot = next;
      return next;
    })
    .finally(() => { inflight = undefined; });
  return inflight;
}

function respond({ stats, timestamp }: Snapshot) {
  return NextResponse.json({ stats, timestamp }, {
    headers: {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
    }
  });
}

export async function GET(req: Request) {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return respond(snapshot);

  const pending = refresh(new URL(req.url).origin, req.headers.get('cookie'));
  // Stale beats slow: answer now, and let the refresh land for the next caller.
  if (snapshot) {
    pending.catch(error => console.error('Stats refresh failed:', error));
    return respond(snapshot);
  }

  try {
    return respond(await pending);
  } catch (error) {
    console.error('Stats aggregation failed:', error);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
