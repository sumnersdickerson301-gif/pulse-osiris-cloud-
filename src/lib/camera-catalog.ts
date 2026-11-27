export type CatalogCamera = { id: string | number; [key: string]: unknown };

/** Partial retries must add cameras, not erase previously loaded regions. */
export function mergeCameraCatalog<T extends { id: string | number }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map(camera => [String(camera.id), camera]));
  for (const camera of incoming) merged.set(String(camera.id), camera);
  return [...merged.values()];
}

const MAX_IMMEDIATE_ATTEMPTS = 3;
const RECOVERY_INTERVAL_MS = 5 * 60_000;
const RECOVERY_CHECK_MS = 60_000;

/**
 * Recover unfinished camera regions without downloading the whole world again.
 * Three bounded fast retries are followed by one check every five minutes.
 * A hidden Android tab does not request data, and focus/visibility can resume
 * overdue checks. The AbortController + inFlight guard prevent overlapping calls.
 */
export function loadCameraCatalog(onBatch: (cameras: CatalogCamera[]) => void, onError: () => void) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let pendingRegions: string[] = ['all'];
  let lastAttemptAt = 0;
  let inFlight = false;

  const visible = () => typeof document === 'undefined' || !document.hidden;
  const load = async (regions: string[]) => {
    if (controller.signal.aborted || inFlight || !regions.length || !visible()) return;
    inFlight = true;
    lastAttemptAt = Date.now();
    attempts++;
    let remaining = regions;
    try {
      const query = new URLSearchParams({ region: regions.join(',') });
      // Let the browser honour the server's ETag/cache headers for completed
      // catalogues; partial responses already carry no-store on the server.
      const response = await fetch(`/api/cctv?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Camera catalogue HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid camera catalogue');
      const catalog = data as { cameras?: unknown; pendingRegions?: unknown };
      if (!Array.isArray(catalog.cameras)) throw new Error('Invalid camera catalogue');
      if (controller.signal.aborted) return;
      if (catalog.cameras.length) onBatch(catalog.cameras);
      remaining = Array.isArray(catalog.pendingRegions)
        ? [...new Set(catalog.pendingRegions.filter((region: unknown): region is string =>
            typeof region === 'string' && /^[a-z-]+$/.test(region)))]
        : catalog.cameras.length ? [] : regions;
    } catch {
      if (controller.signal.aborted) return;
      onError();
    } finally {
      inFlight = false;
    }
    pendingRegions = remaining;
    if (remaining.length && attempts < MAX_IMMEDIATE_ATTEMPTS && !controller.signal.aborted) {
      timer = setTimeout(() => { timer = undefined; void load(remaining); }, attempts * 15_000);
    }
  };

  // Single timer shared by all recovery cycles. No polling after completion.
  const recoverIfDue = () => {
    if (controller.signal.aborted || inFlight || timer || !pendingRegions.length || !visible()) return;
    if (Date.now() - lastAttemptAt < RECOVERY_INTERVAL_MS) return;
    attempts = 0;
    void load(pendingRegions);
  };
  const interval = setInterval(recoverIfDue, RECOVERY_CHECK_MS);
  const onResume = () => recoverIfDue();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onResume);
  if (typeof window !== 'undefined') window.addEventListener('focus', onResume);

  void load(['all']);
  return () => {
    controller.abort();
    clearTimeout(timer);
    clearInterval(interval);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onResume);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onResume);
  };
}
