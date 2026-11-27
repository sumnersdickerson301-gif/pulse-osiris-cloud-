import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 45;

const MAX_ITEMS = 12;
const MAX_TITLE = 220;
const TRANSLATION_TTL = 6 * 60 * 60_000;
const cache = new Map<string, { title: string; expiresAt: number }>();

/** A best-effort public headline translator; it does NOT rewrite source links.
 * The upstream is an unofficial, unauthenticated service: use a strict timeout,
 * low concurrency, per-IP rate limiting, and preserve English when unavailable.
 * Set OSIRIS_TRANSLATE_OFF=1 to disable it if the provider changes access.
 */
async function translateHeadline(original: string): Promise<string | null> {
  if (/[А-Яа-яЁё]/u.test(original)) return original;
  const cached = cache.get(original);
  if (cached && cached.expiresAt > Date.now()) return cached.title;

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', 'ru');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', original);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const fragments = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
    const translated = fragments.map((part: unknown) =>
      Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''
    ).join('').trim();
    if (!translated || translated.length > MAX_TITLE * 3 || !/[А-Яа-яЁё]/u.test(translated)) return null;
    cache.set(original, { title: translated, expiresAt: Date.now() + TRANSLATION_TTL });
    if (cache.size > 1_000) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    return translated;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (process.env.OSIRIS_TRANSLATE_OFF === '1') {
    return NextResponse.json({ translations: {}, unavailable: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (isRateLimited('news-translator:' + getClientIp(request), 8, 60_000)) {
    return NextResponse.json({ translations: {}, unavailable: true, reason: 'rate_limited' }, { status: 429 });
  }

  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 4_096) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });

  let raw: string;
  try { raw = await request.text(); } catch { return NextResponse.json({ error: 'Body unreadable' }, { status: 400 }); }
  if (raw.length > 4_096) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const payload = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const headlines = payload?.headlines;
  if (!Array.isArray(headlines) || headlines.length === 0 || headlines.length > MAX_ITEMS ||
      headlines.some(item => typeof item !== 'string' || item.length < 1 || item.length > MAX_TITLE)) {
    return NextResponse.json({ error: 'Expected 1-12 short headlines' }, { status: 400 });
  }

  const titles = [...new Set(headlines as string[])];
  const translations: Record<string, string> = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, titles.length) }, async () => {
    while (cursor < titles.length) {
      const original = titles[cursor++];
      const result = await translateHeadline(original);
      if (result) translations[original] = result;
    }
  }));
  const unavailable = Object.keys(translations).length < titles.length;
  return NextResponse.json({ translations, unavailable }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
