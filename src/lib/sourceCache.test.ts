import { describe, it, expect, beforeEach } from 'vitest';
import { cachedSource, clearSourceCache, sourceCacheHealth, FORBIDDEN_RETRY_MS } from './sourceCache';

type Cam = { id: string };
const cam = (id: string): Cam => ({ id });

beforeEach(() => clearSourceCache());

describe('cachedSource', () => {
  it('fetches once and serves the cached list afterwards', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t1', async () => { calls++; return [cam('a')]; });

    expect(await load()).toEqual([cam('a')]);
    expect(await load()).toEqual([cam('a')]);
    expect(calls).toBe(1);
    expect(sourceCacheHealth('t1')).toMatchObject({
      state: 'ok',
      lastErrorAt: null,
    });
    expect(sourceCacheHealth('t1')?.lastSuccessAt).toEqual(expect.any(Number));
  });

  it('refetches once the TTL has elapsed', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t2', async () => { calls++; return [cam(`v${calls}`)]; }, 10);

    await load();
    await new Promise((r) => setTimeout(r, 25));
    expect(await load()).toEqual([cam('v2')]);
    expect(calls).toBe(2);
  });

  // region=all fans out to every source at once — a cold cache must not
  // multiply into N concurrent upstream requests.
  it('collapses concurrent misses into a single upstream call', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t3', async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return [cam('a')];
    });

    const all = await Promise.all([load(), load(), load(), load()]);
    expect(calls).toBe(1);
    for (const r of all) expect(r).toEqual([cam('a')]);
  });

  it('keeps serving the last good list when a refresh throws', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const load = cachedSource<Cam>('t4', async () => {
      if (mode === 'fail') throw new Error('upstream down');
      return [cam('good')];
    }, 10);

    expect(await load()).toEqual([cam('good')]);
    mode = 'fail';
    await new Promise((r) => setTimeout(r, 25));
    // stale data rather than an empty layer
    expect(await load()).toEqual([cam('good')]);
    expect(sourceCacheHealth('t4')?.state).toBe('degraded');
    expect(sourceCacheHealth('t4')?.lastErrorAt).toEqual(expect.any(Number));
    expect(sourceCacheHealth('t4')?.lastSuccessAt).toEqual(expect.any(Number));
  });

  it('treats an empty refresh as a failed one and holds the previous list', async () => {
    let mode: 'ok' | 'empty' = 'ok';
    const load = cachedSource<Cam>('t5', async () => (mode === 'ok' ? [cam('good')] : []), 10);

    await load();
    mode = 'empty';
    await new Promise((r) => setTimeout(r, 25));
    expect(await load()).toEqual([cam('good')]);
    expect(sourceCacheHealth('t5')?.state).toBe('degraded');
  });

  it('returns empty when the first fetch fails with nothing cached', async () => {
    const load = cachedSource<Cam>('t6', async () => { throw new Error('down'); });
    expect(await load()).toEqual([]);
    expect(sourceCacheHealth('t6')?.state).toBe('error');
    expect(sourceCacheHealth('t6')?.lastSuccessAt).toBeNull();
  });

  it('distinguishes a clean empty response from a failed source', async () => {
    const load = cachedSource<Cam>('empty', async () => [], 10);
    expect(await load()).toEqual([]);
    expect(sourceCacheHealth('empty')?.state).toBe('empty');
    expect(sourceCacheHealth('empty')?.lastErrorAt).toBeNull();
  });

  it('negative-caches transient failures instead of retrying on each dashboard request', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('transient', async () => {
      calls++;
      throw new Error('HTTP 503');
    }, 10);
    expect(await load()).toEqual([]);
    expect(await load()).toEqual([]);
    expect(calls).toBe(1);
    expect(sourceCacheHealth('transient')?.state).toBe('error');
  });

  it('backs off forbidden HTTP 403 sources for 15 minutes and reports the retry time', async () => {
    let calls = 0;
    const before = Date.now();
    const load = cachedSource<Cam>('forbidden', async () => {
      calls++;
      throw new Error('HTTP 403');
    }, 10);
    expect(await load()).toEqual([]);
    expect(await load()).toEqual([]);
    expect(calls).toBe(1);
    const health = sourceCacheHealth('forbidden');
    expect(health?.state).toBe('blocked');
    expect(health?.lastSuccessAt).toBeNull();
    expect(health?.nextRetryAt).toBeGreaterThanOrEqual(before + FORBIDDEN_RETRY_MS);
  });

  it('preserves last good records when a source becomes forbidden', async () => {
    let blocked = false;
    const load = cachedSource<Cam>('forbidden-after-ok', async () => {
      if (blocked) throw new Error('Status: 403');
      return [cam('last-good')];
    }, 10);
    expect(await load()).toEqual([cam('last-good')]);
    const successAt = sourceCacheHealth('forbidden-after-ok')?.lastSuccessAt;
    blocked = true;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(await load()).toEqual([cam('last-good')]);
    expect(sourceCacheHealth('forbidden-after-ok')?.state).toBe('blocked');
    expect(sourceCacheHealth('forbidden-after-ok')?.lastSuccessAt).toBe(successAt);
  });

  it('keeps separate keys independent', async () => {
    const a = cachedSource<Cam>('t7a', async () => [cam('a')]);
    const b = cachedSource<Cam>('t7b', async () => [cam('b')]);
    expect(await a()).toEqual([cam('a')]);
    expect(await b()).toEqual([cam('b')]);
  });
});
