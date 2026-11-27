import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRailwayNews, RAILWAY_NEWS_URL, resetRailwayNewsBackoff, validRailwayNews } from './railway-news';

const date = '2026-11-27T18:00:00.000Z';
const fixture = () => ({
  news: [{
    id: 'report-1', title: 'OSINT source report', summary: 'Short',
    description: 'The original report text', published: date,
    link: 'https://example.org/report-1', source: 'example.org',
    source_name: 'Example', risk_score: 2,
  }],
  total: 1,
  sources: [{ handle: 'example', state: 'ok', count: 1 }],
  health: { total: 1, reachable: 1 },
  timestamp: date,
});
const json = (payload = fixture()) => Response.json(payload);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-27T18:01:00.000Z'));
  resetRailwayNewsBackoff();
  delete process.env.OSIRIS_NEWS_BACKEND;
});
afterEach(() => {
  delete process.env.OSIRIS_NEWS_BACKEND;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Railway news pilot', () => {
  it('is disabled by default, so production keeps its local data source', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    expect(await loadRailwayNews()).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('fetches only the fixed HTTPS Railway service, without credentials', async () => {
    process.env.OSIRIS_NEWS_BACKEND = 'railway';
    const mock = vi.fn(async () => json());
    vi.stubGlobal('fetch', mock);
    expect((await loadRailwayNews())?.news).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RAILWAY_NEWS_URL);
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('refuses stale or structurally invalid news rather than replacing valid local stories', () => {
    expect(validRailwayNews(fixture())).toBe(true);
    expect(validRailwayNews({ ...fixture(), timestamp: '2020-01-01T00:00:00Z' })).toBe(false);
    expect(validRailwayNews({ ...fixture(), sources: [] })).toBe(false);
    expect(validRailwayNews({ ...fixture(), total: 99 })).toBe(false);
    expect(validRailwayNews({ ...fixture(), news: [{ id: 'broken' }] })).toBe(false);
    expect(validRailwayNews({ ...fixture(), news: [], total: 0,
      sources: [{ handle: 'x', state: 'error', count: 0 }] })).toBe(false);
    expect(validRailwayNews({ ...fixture(), news: [], total: 0,
      sources: [{ handle: 'x', state: 'empty', count: 0 }] })).toBe(true);
  });

  it('backs off for a minute after an unusable Railway answer and then retries', async () => {
    process.env.OSIRIS_NEWS_BACKEND = 'railway';
    const mock = vi.fn().mockResolvedValueOnce(new Response('<!DOCTYPE html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })).mockResolvedValueOnce(json());
    vi.stubGlobal('fetch', mock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadRailwayNews()).toBeNull();
    expect(await loadRailwayNews()).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-27T18:02:01.000Z'));
    expect((await loadRailwayNews())?.news).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('rejects out-of-date but syntactically valid Railway JSON', async () => {
    process.env.OSIRIS_NEWS_BACKEND = 'railway';
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...fixture(), timestamp: '2026-11-20T18:00:00.000Z' })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadRailwayNews()).toBeNull();
  });
});
