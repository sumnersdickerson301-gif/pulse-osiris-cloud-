/**
 * OSIRIS Railway news pilot.
 *
 * Railway runs a persistent OSIRIS container, whose /api/news can pre-aggregate
 * OSINT while Vercel serves the UI. Opt-in per deployment:
 *   OSIRIS_NEWS_BACKEND=railway
 *
 * Only the verified Railway service below is contacted (no user-selected URL,
 * redirects, credentials or browser cookies). Production defaults to local.
 * On timeout, HTTP failure or incompatible/stale payload, callers use their
 * existing Vercel collector. This is a pilot, not persistent shared storage.
 */
export const RAILWAY_ORIGIN = 'https://osiris-production-807f1d73.up.railway.app';
export const RAILWAY_NEWS_URL = `${RAILWAY_ORIGIN}/api/news`;
export const RAILWAY_HEALTH_URL = `${RAILWAY_ORIGIN}/api/health`;

const MAX_AGE_MS = 20 * 60_000;
const MAX_NEWS_BYTES = 4_000_000;
const BACKOFF_MS = 60_000;
let nextAttemptAt = 0;

export type RailwayNewsEnvelope = {
  news: Array<Record<string, unknown>>;
  total: number;
  sources: Array<Record<string, unknown>>;
  health: Record<string, unknown>;
  timestamp: string;
};

export function railwayNewsEnabled(): boolean {
  return process.env.OSIRIS_NEWS_BACKEND === 'railway';
}

/** Validate the exact downstream schema and current collection timestamp. */
export function validRailwayNews(payload: unknown, now = Date.now()): payload is RailwayNewsEnvelope {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.news) || p.news.length > 5000) return false;
  if (!Array.isArray(p.sources) || p.sources.length < 1 || p.sources.length > 200) return false;
  if (!p.health || typeof p.health !== 'object' || Array.isArray(p.health)) return false;
  if (typeof p.total !== 'number' || !Number.isFinite(p.total) || p.total !== p.news.length) return false;
  if (typeof p.timestamp !== 'string') return false;
  const time = Date.parse(p.timestamp);
  if (!Number.isFinite(time) || time < now - MAX_AGE_MS || time > now + 2 * 60_000) return false;
  if (!p.sources.every((s: unknown) => s && typeof s === 'object'
    && typeof (s as Record<string, unknown>).handle === 'string'
    && typeof (s as Record<string, unknown>).state === 'string')) return false;
  if (!p.news.every((n: unknown) => {
    if (!n || typeof n !== 'object') return false;
    const item = n as Record<string, unknown>;
    return typeof item.id === 'string'
      && typeof item.title === 'string'
      && typeof item.published === 'string'
      && Number.isFinite(Date.parse(item.published))
      && typeof item.link === 'string';
  })) return false;
  // An empty response from all broken sources is not proof of a valid feed.
  if (p.news.length === 0 && !p.sources.some((s: Record<string, unknown>) =>
    s.state === 'ok' || s.state === 'empty')) return false;
  return true;
}

export async function loadRailwayNews(): Promise<RailwayNewsEnvelope | null> {
  if (!railwayNewsEnabled() || Date.now() < nextAttemptAt) return null;
  try {
    const response = await fetch(RAILWAY_NEWS_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error(`Railway news HTTP ${response.status}, not a JSON feed`);
    }
    const size = Number(response.headers.get('content-length') ?? 0);
    if (size > MAX_NEWS_BYTES) throw new Error('Railway news payload too large');
    const raw = await response.text();
    if (raw.length > MAX_NEWS_BYTES) throw new Error('Railway news payload too large');
    const payload: unknown = JSON.parse(raw);
    if (!validRailwayNews(payload)) throw new Error('Railway news payload malformed or stale');
    nextAttemptAt = 0;
    return payload;
  } catch (error) {
    nextAttemptAt = Date.now() + BACKOFF_MS;
    console.warn('[OSIRIS] Railway news unavailable; using local collector:', error instanceof Error ? error.message : 'network error');
    return null;
  }
}

/** Resets only local backoff state; intended for unit tests. */
export function resetRailwayNewsBackoff(): void {
  nextAttemptAt = 0;
}
