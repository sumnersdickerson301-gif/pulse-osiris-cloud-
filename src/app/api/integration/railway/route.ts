import { NextResponse } from 'next/server';
import { RAILWAY_HEALTH_URL, railwayNewsEnabled } from '@/lib/railway-news';

export const dynamic = 'force-dynamic';

/**
 * Read-only pilot diagnostics. "serving" proves only the Railway application
 * process is reachable, not that Telegram/RSS upstreams are functioning.
 * Never forward browser cookies or expose environment variable values.
 */
export async function GET() {
  const mode = railwayNewsEnabled() ? 'railway-with-local-fallback' : 'local';
  try {
    const response = await fetch(RAILWAY_HEALTH_URL, {
      signal: AbortSignal.timeout(4_000),
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error('Railway process health did not return JSON');
    }
    const data: unknown = await response.json();
    const health = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    return NextResponse.json({
      mode,
      railway: {
        reachable: health.status === 'serving' && health.scope === 'process',
        scope: 'process',
        uptime_seconds: typeof health.uptime_seconds === 'number' ? health.uptime_seconds : null,
        upstreams_checked: false,
      },
      checked_at: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({
      mode,
      railway: { reachable: false, scope: 'process', upstreams_checked: false },
      checked_at: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
