/**
 * OSIRIS — upstream source cache.
 *
 * Camera *indexes* (where the cameras are) change on the order of weeks, while
 * the frames themselves are pulled live by the client straight from the source.
 * Re-downloading a 500 KB index on every request is pure waste — and some of
 * these upstreams are slow enough to dominate the response (MDOT ~7s, NZTA ~8s),
 * so an uncached `region=all` took ~15s every single time.
 *
 * Three behaviours matter here:
 *   • TTL        — serve from memory until the index is plausibly stale.
 *   • dedup      — concurrent misses share one upstream request instead of
 *                  stampeding it (a `region=all` fan-out hits every source at once).
 *   • stale-on-error — if the upstream fails, keep serving the last good index
 *                  rather than dropping the layer to zero cameras.
 */

export type SourceCacheState = 'ok' | 'empty' | 'degraded' | 'error' | 'blocked' | 'seeded';

export interface SourceCacheHealth {
  state: SourceCacheState;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastErrorAt: number | null;
  /** Populated when a failed upstream has a retry cooldown. */
  nextRetryAt?: number | null;
}

interface Entry<T> {
  data: T[];
  expiresAt: number;
  inflight: Promise<T[]> | null;
  health: SourceCacheHealth;
}

/** Source-specific telemetry — a cached array alone cannot prove a feed is live. */
export function sourceCacheHealth(key: string): SourceCacheHealth | null {
  const entry = store.get(key);
  return entry ? {
    ...entry.health,
    nextRetryAt: entry.health.state === 'blocked' || entry.health.state === 'error' || entry.health.state === 'degraded'
      ? entry.expiresAt
      : null,
  } : null;
}

const store = new Map<string, Entry<unknown>>();

export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Access-denied feeds need a longer cooldown than transient outages. This is
// a per-runtime cooldown, not a claim that the upstream became reachable.
export const FORBIDDEN_RETRY_MS = 15 * 60_000;
const FAILURE_RETRY_MS = 60_000;
function isForbiddenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP|Status:)\s*403\b/i.test(message);
}

/**
 * Cap on distinct keys. Camera sources are a fixed handful, but callers with
 * per-coordinate keys (place lookups) would otherwise grow this map without
 * bound. Map preserves insertion order, so the oldest keys evict first.
 */
const MAX_ENTRIES = 500;

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  for (const key of store.keys()) {
    if (store.size <= MAX_ENTRIES) break;
    const entry = store.get(key);
    if (entry?.inflight) continue; // never drop a request in progress
    store.delete(key);
  }
}

/**
 * Wrap a camera fetcher with TTL caching, in-flight dedup and stale fallback.
 * Returns a drop-in replacement with the same signature.
 */
export function cachedSource<T>(
  key: string,
  fetcher: () => Promise<T[]>,
  ttlMs: number = DEFAULT_TTL_MS,
): () => Promise<T[]> {
  return async () => {
    const now = Date.now();
    const entry = store.get(key) as Entry<T> | undefined;

    if (entry?.inflight) return entry.inflight;
    // Negative-cache empty and failed responses too. Previously an empty
    // array bypassed the TTL, so a blocked feed retried on EVERY request.
    if (entry && now < entry.expiresAt) return entry.data;

    const inflight = (async () => {
      try {
        const data = await fetcher();
        // An empty result is treated as a failed refresh: keep whatever we had.
        if (data.length === 0 && entry?.data.length) {
          // Empty upstream response must never be mistaken for a fresh index.
          store.set(key, {
            data: entry.data, expiresAt: now + ttlMs, inflight: null,
            health: { state: 'degraded', lastSuccessAt: entry.health.lastSuccessAt, lastAttemptAt: now, lastErrorAt: Date.now() },
          });
          return entry.data;
        }
        store.set(key, {
          data, expiresAt: now + ttlMs, inflight: null,
          health: { state: data.length ? 'ok' : 'empty', lastSuccessAt: Date.now(), lastAttemptAt: now, lastErrorAt: null },
        });
        return data;
      } catch (e) {
        const blocked = isForbiddenError(e);
        const retryIn = blocked ? FORBIDDEN_RETRY_MS : FAILURE_RETRY_MS;
        const state: SourceCacheState = blocked ? 'blocked' : entry?.data.length ? 'degraded' : 'error';
        if (entry?.data.length) {
          console.warn(`[OSIRIS] ${key} upstream ${blocked ? 'HTTP 403' : 'error'} — serving ${entry.data.length} cached records; retry in ${retryIn / 60_000}m`);
          store.set(key, {
            data: entry.data, expiresAt: Date.now() + retryIn, inflight: null,
            health: { state, lastSuccessAt: entry.health.lastSuccessAt, lastAttemptAt: now, lastErrorAt: Date.now() },
          });
          return entry.data;
        }
        console.warn(`[OSIRIS] ${key} upstream fetch failed without cached records:`, e);
        store.set(key, {
          data: [], expiresAt: Date.now() + retryIn, inflight: null,
          health: { state, lastSuccessAt: entry?.health.lastSuccessAt ?? null, lastAttemptAt: now, lastErrorAt: Date.now() },
        });
        return [];
      }
    })();

    store.set(key, {
      data: entry?.data ?? [],
      expiresAt: entry?.expiresAt ?? 0,
      inflight,
      health: entry?.health ?? { state: 'empty', lastSuccessAt: null, lastAttemptAt: now, lastErrorAt: null },
    } as Entry<unknown>);
    evictIfNeeded();

    return inflight;
  };
}

/**
 * Read a source without triggering a fetch.
 *
 * The catalogue route uses this to answer from what it already has and to
 * queue only the regions it is actually missing — otherwise every request
 * enqueues all 48 regions into the pool, and a warm catalogue still pays for a
 * queue it does not need.
 */
export function peekSource<T>(key: string, allowStale = false): T[] | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry || entry.data.length === 0) return undefined;
  if (allowStale || Date.now() < entry.expiresAt) return entry.data;
  return undefined;
}

/** Is what peekSource would return past its TTL? */
export function isStale(key: string): boolean {
  const entry = store.get(key);
  return !entry || Date.now() >= entry.expiresAt;
}

/**
 * Install data the process did not fetch — a catalogue restored from disk.
 * Serving that at boot is the difference between a map that is populated on the
 * first request and one that waits on forty-eight upstreams to answer.
 */
export function seedSource<T>(key: string, data: T[], ttlMs: number = DEFAULT_TTL_MS): void {
  if (!data.length) return;
  const entry = store.get(key);
  if (entry?.inflight) return; // a live fetch already supersedes the snapshot
  store.set(key, {
    data, expiresAt: Date.now() + ttlMs, inflight: null,
    health: { state: 'seeded', lastSuccessAt: null, lastAttemptAt: null, lastErrorAt: null },
  } as Entry<unknown>);
  evictIfNeeded();
}

/** Test seam — drops all cached indexes. */
export function clearSourceCache(): void {
  store.clear();
}
