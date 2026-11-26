import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, matchZone, isRecentConflictHeadline } from './route';

describe('matchZone', () => {
  it('files a headline under the zone whose query it contains, word for word', () => {
    expect(matchZone('Russia launches drones in Ukraine war escalation')?.id).toBe('ukraine');
    expect(matchZone('Houthi missile ship strike near Eritrea')?.id).toBe('red-sea');
  });

  it('reads hyphenated names and plurals as their words', () => {
    expect(matchZone('Ukraine-Russia war talks stall')?.id).toBe('ukraine');
    expect(matchZone('Fresh airstrikes on Gaza overnight')?.id).toBe('gaza');
  });

  it('does not match on a substring or on the country name alone', () => {
    // "war" inside "warning" used to count.
    expect(matchZone('Ukraine issues frost warning for farmers')).toBeNull();
    // The bare region name used to be enough on its own.
    expect(matchZone('Sudan wins the regional football final')).toBeNull();
  });
});

describe('GET /api/conflicts', () => {
  afterEach(() => vi.unstubAllGlobals());

  const rss = (...titles: string[]) =>
    `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><link>https://news.example/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

  it('lists headlines under their zone and plots none of them', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('bbc')
        ? new Response(rss('UN marks anniversary of Ukraine war with London vigil', 'Weather in Paris'))
        : new Response('', { status: 503 })));

    const body = await (await GET()).json();
    const ukraine = body.zones.find((z: { id: string }) => z.id === 'ukraine');

    expect(ukraine.headlineCount).toBe(1);
    expect(ukraine.headlines[0]).toMatchObject({
      title: 'UN marks anniversary of Ukraine war with London vigil',
      url: 'https://news.example/0',
      source: 'BBC News',
    });
    expect(Number.isFinite(Date.parse(ukraine.headlines[0].published))).toBe(true);
    // A headline names a place; it is not an event at a point.
    expect(ukraine.headlines[0]).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('liveEvents');
    expect(body.totalHeadlines).toBe(1);
    expect(body.zoneSource).toBe('curated');
  });

  it('carries the same story once when several feeds run it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss('Gaza airstrike kills dozens'))));
    const body = await (await GET()).json();
    expect(body.zones.find((z: { id: string }) => z.id === 'gaza').headlineCount).toBe(1);
  });
});

describe('conflict feed freshness', () => {
  it('accepts recent dated stories but rejects old, future and undated ones', () => {
    const now = Date.parse('2026-11-27T12:00:00Z');
    expect(isRecentConflictHeadline('Fri, 27 Nov 2026 11:00:00 GMT', now)).toBe(true);
    expect(isRecentConflictHeadline('Tue, 24 Nov 2026 10:00:00 GMT', now)).toBe(false);
    expect(isRecentConflictHeadline('Fri, 27 Nov 2026 12:10:00 GMT', now)).toBe(false);
    expect(isRecentConflictHeadline('', now)).toBe(false);
    expect(isRecentConflictHeadline('invalid', now)).toBe(false);
  });

  it('excludes stale and undated RSS items even when their titles match a conflict', async () => {
    const recent = new Date().toUTCString();
    const old = new Date(Date.now() - 5 * 24 * 60 * 60_000).toUTCString();
    const items = [
      `<item><title>Ukraine war new report</title><link>https://news.example/new</link><pubDate>${recent}</pubDate></item>`,
      `<item><title>Ukraine war old report</title><link>https://news.example/old</link><pubDate>${old}</pubDate></item>`,
      '<item><title>Ukraine war undated report</title><link>https://news.example/undated</link></item>',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<rss><channel>${items.join('')}</channel></rss>`)));
    const body = await (await GET()).json();
    const ukraine = body.zones.find((z: { id: string }) => z.id === 'ukraine');
    expect(ukraine.headlineCount).toBe(1);
    expect(ukraine.headlines[0].title).toBe('Ukraine war new report');
    expect(body.headlineWindowHours).toBe(72);
    expect(body.latestHeadlineAt).not.toBeNull();
  });
});
