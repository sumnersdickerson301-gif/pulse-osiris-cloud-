import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const noStore = { 'Cache-Control': 'private, no-store' } as const;

/**
 * Server-only read proxy for a FUTURE dedicated Railway archive service.
 * Remains disabled until both scoped environment variables are configured.
 * No Railway token is ever returned to the browser.
 */
export async function GET(request: NextRequest) {
  if (isRateLimited('osiris-history:' + getClientIp(request), 30, 60_000)) {
    return NextResponse.json({ error: 'Too many history requests' }, { status: 429, headers: noStore });
  }

  const endpoint = process.env.OSIRIS_HISTORY_API_URL;
  const token = process.env.OSIRIS_HISTORY_API_TOKEN;
  if (!endpoint || !token || token.length < 32) {
    return NextResponse.json({ error: 'History archive not configured' }, { status: 503, headers: noStore });
  }

  let destination: URL;
  try {
    destination = new URL(endpoint);
    // Strictly pin the external destination to a Railway-hosted HTTPS service.
    // Never use a browser supplied target, accept credentials in its URL,
    // or follow redirects to an unrelated host.
    if (destination.protocol !== 'https:' || !destination.hostname.endsWith('.up.railway.app') ||
        destination.username || destination.password || destination.search || destination.hash ||
        destination.pathname !== '/' && destination.pathname !== '') throw new Error('Invalid Railway host');
    destination.pathname = '/events';
  } catch {
    return NextResponse.json({ error: 'History archive configuration invalid' }, { status: 503, headers: noStore });
  }

  const params = request.nextUrl.searchParams;
  const rawLimit = params.get('limit') ?? '30';
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: 'Expected limit from 1 to 100' }, { status: 400, headers: noStore });
  }
  destination.searchParams.set('limit', String(limit));

  const before = params.get('before');
  if (before !== null) {
    const time = Date.parse(before);
    if (!Number.isFinite(time) || before.length > 40) {
      return NextResponse.json({ error: 'Invalid before timestamp' }, { status: 400, headers: noStore });
    }
    destination.searchParams.set('before', new Date(time).toISOString());
  }

  try {
    const response = await fetch(destination, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error('Archive unavailable or invalid response');
    }
    const size = Number(response.headers.get('content-length') ?? 0);
    if (size > 2_000_000) throw new Error('Archive response too large');
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Archive response too large');
    const parsed: unknown = JSON.parse(text);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    if (!data || !Array.isArray(data.events) || data.events.length > limit ||
        !data.events.every(event => event && typeof event === 'object' &&
          typeof event.id === 'string' && typeof event.title === 'string' &&
          typeof event.published === 'string')) throw new Error('Invalid archive data');
    return NextResponse.json({ events: data.events, limit }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: 'History archive temporarily unavailable' }, { status: 502, headers: noStore });
  }
}
