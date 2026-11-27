import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCameraCatalog, mergeCameraCatalog } from './camera-catalog';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (cameras: { id: string }[], pendingRegions: string[] = []) => Response.json({ cameras, pendingRegions });

describe('progressive camera catalogue', () => {
  it('retries only missing regions, preserving cameras already loaded', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: 'london' }], ['canada']))
      .mockResolvedValueOnce(json([{ id: 'ottawa' }]));
    vi.stubGlobal('fetch', fetcher);
    let cameras: { id: string | number }[] = [];
    const stop = loadCameraCatalog(batch => { cameras = mergeCameraCatalog(cameras, batch); }, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(cameras).toEqual([{ id: 'london' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetcher.mock.calls[1][0]).toBe('/api/cctv?region=canada');
    expect(cameras).toEqual([{ id: 'london' }, { id: 'ottawa' }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
  });

  it('bounds retries of unavailable sources and retries failed initial requests', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => json([], ['canada']));
    vi.stubGlobal('fetch', fetcher);
    const onError = vi.fn();
    const stop = loadCameraCatalog(vi.fn(), onError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
  });

  it('recovers a missing camera region after the five-minute cooldown', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json([{ id: 'london' }], ['canada']))
      .mockResolvedValueOnce(json([], ['canada']))
      .mockResolvedValueOnce(json([], ['canada']))
      .mockResolvedValueOnce(json([{ id: 'ottawa' }]));
    vi.stubGlobal('fetch', fetcher);
    let cameras: { id: string | number }[] = [];
    const stop = loadCameraCatalog(batch => {
      cameras = mergeCameraCatalog(cameras, batch);
    }, vi.fn());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cameras).toEqual([{ id: 'london' }]);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[3][0]).toBe('/api/cctv?region=canada');
    expect(cameras).toEqual([{ id: 'london' }, { id: 'ottawa' }]);

    // A complete catalogue must not keep polling every five minutes.
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    stop();
  });

  it('never silently accepts malformed camera records as valid', async () => {
    const fetcher = vi.fn(async () => Response.json({
      cameras: [{ invalid: true }, { id: 'valid' }],
      pendingRegions: [],
    }));
    vi.stubGlobal('fetch', fetcher);
    const onBatch = vi.fn();
    const stop = loadCameraCatalog(onBatch, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(onBatch).toHaveBeenCalledWith([{ id: 'valid' }]);
    stop();
  });

  it('cancels queued retries when cameras are switched off', async () => {
    const fetcher = vi.fn(async () => json([], ['canada']));
    vi.stubGlobal('fetch', fetcher);
    const stop = loadCameraCatalog(vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('updates duplicate camera IDs without duplicating dots', () => {
    expect(mergeCameraCatalog([{ id: 'a', name: 'old' }], [{ id: 'a', name: 'new' }, { id: 'b', name: 'second' }]))
      .toEqual([{ id: 'a', name: 'new' }, { id: 'b', name: 'second' }]);
  });
});
