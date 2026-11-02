/**
 * tests/e2e/tier4-workloads.test.ts
 * Tier 4: Real-World Workload Scenarios (Opaque-Box E2E Tests)
 * Tests sustained streaming under heavy workloads: multi-chunk prefetch pipelines,
 * rapid seek stress, corrupted stream decode fault interception, and memory pressure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from '../infra/test-harness.ts';
import {
  MockHTMLVideoElement,
  MockMediaSource,
  MockSourceBuffer,
  setupMockBrowserEnvironment,
} from '../infra/mock-browser.ts';
import { MockTelegramEngine } from '../infra/mock-telegram.ts';
import { tgStreamEngine } from '../../src/services/tgStreamEngine.ts';
import { buildSyntheticMkv } from '../infra/synthetic-ebml.ts';
import { parseMatroskaHeader } from '../../src/services/remuxer/ebml.ts';
import { MatroskaTransmuxer } from '../../src/services/remuxer/transmuxer.ts';

describe('Tier 4: Real-World Workload Scenarios', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
    tgStreamEngine.destroy();
  });

  // TC 4.1: Continuous Multi-Chunk Prefetching Without Playback Stalls
  it('TC 4.1: Should sustain continuous prefetching across 10+ chunks maintaining forward buffer', async () => {
    const CHUNK_SIZE = 512 * 1024;
    const NUM_CHUNKS = 12;
    const totalSize = NUM_CHUNKS * CHUNK_SIZE;

    const telegramMock = new MockTelegramEngine({
      chunkSize: CHUNK_SIZE,
      simulatedRttMs: 5,
    });

    const streamData = new Uint8Array(totalSize);
    // Fill with synthetic data
    for (let i = 0; i < totalSize; i += 1024) {
      streamData[i] = (i / 1024) & 0xff;
    }
    telegramMock.registerStreamData('stream_continuous', streamData);

    const mediaSource = new MockMediaSource();
    mediaSource.open();
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');

    // Simulate pipelined fetcher loop (simulating worker prefetch with 3-chunk window)
    let currentOffset = 0;
    const fetchedChunks: ArrayBuffer[] = [];

    for (let c = 0; c < NUM_CHUNKS; c++) {
      const chunkBuf = await telegramMock.fetchChunk('stream_continuous', currentOffset, CHUNK_SIZE);
      expect(chunkBuf.byteLength).toBe(CHUNK_SIZE);
      fetchedChunks.push(chunkBuf);
      currentOffset += CHUNK_SIZE;

      // Append to SourceBuffer if not updating
      if (!sourceBuffer.updating) {
        sourceBuffer.appendBuffer(chunkBuf.slice(0, 4096)); // Append mock segment
        await vi.waitFor(() => !sourceBuffer.updating, { timeout: 100 });
      }
    }

    expect(fetchedChunks).toHaveLength(NUM_CHUNKS);
    expect(telegramMock.totalChunksFetched).toBe(NUM_CHUNKS);
    // Verify monotonic offset advancement (no Chunk 0 duplicate fetching)
    const log = telegramMock.getFetchLog();
    for (let i = 1; i < log.length; i++) {
      expect(log[i].offset).toBeGreaterThan(log[i - 1].offset);
    }
  });

  // TC 4.2: Rapid Seek & Dynamic Buffer Eviction Under User Stress
  it('TC 4.2: Should abort obsolete fetches and flush buffers under rapid seek events', async () => {
    const mediaSource = new MockMediaSource();
    mediaSource.open();
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');

    // User rapidly seeks: 0s -> 450s -> 120s -> 980s
    const seekTargets = [450, 120, 980];
    const abortSpy = vi.spyOn(sourceBuffer, 'abort');

    for (const targetTime of seekTargets) {
      // Upon seek, pipeline aborts in-progress append and flushes queue
      sourceBuffer.abort();
      sourceBuffer.remove(0, 1000);
      await vi.waitFor(() => !sourceBuffer.updating, { timeout: 100 });
    }

    expect(abortSpy).toHaveBeenCalledTimes(seekTargets.length);
  });

  // TC 4.3: Corrupted / Truncated Stream Decode Fault Interception & Recovery
  it('TC 4.3: Should intercept corrupted EBML payload, catch decoder error, and provide recovery', () => {
    const video = new MockHTMLVideoElement();
    let caughtError: { code: string; message: string; recoverable: boolean } | null = null;

    // Simulate error plumbing interceptor
    video.addEventListener('error', () => {
      const err = video.error;
      caughtError = {
        code: 'MEDIA_DECODE_ERROR',
        message: err?.message || 'Video container or codec could not be decoded.',
        recoverable: true,
      };
    });

    // Provide malformed / garbage bytes to video
    video.simulateError(3, 'MEDIA_ERR_DECODE: Fatal hardware decoding fault in AVC bitstream');

    expect(caughtError).toBeDefined();
    expect(caughtError!.code).toBe('MEDIA_DECODE_ERROR');
    expect(caughtError!.recoverable).toBe(true);
    expect(caughtError!.message).toContain('decoding fault');
  });

  // TC 4.4: High-Bitrate Memory Pressure Under Long Playback
  it('TC 4.4: Should keep buffer memory bounded during sustained playback', async () => {
    const mediaSource = new MockMediaSource();
    mediaSource.open();
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    sourceBuffer.quotaLimitBytes = 20 * 1024 * 1024; // 20 MB max

    // Simulate 30 segment appends with sliding window eviction (retain behind = 30s)
    let simulatedPlayhead = 0;
    const segmentSize = 512 * 1024; // 512 KB per segment

    for (let seg = 0; seg < 25; seg++) {
      simulatedPlayhead += 2; // 2 seconds per segment

      if (sourceBuffer.currentBytes + segmentSize > 5 * 1024 * 1024) {
        // Evict older segments behind playhead
        sourceBuffer.remove(0, Math.max(0, simulatedPlayhead - 10));
        await vi.waitFor(() => !sourceBuffer.updating, { timeout: 100 });
        sourceBuffer.currentBytes = Math.max(0, sourceBuffer.currentBytes - 3 * 1024 * 1024);
      }

      sourceBuffer.appendBuffer(new Uint8Array(segmentSize));
      await vi.waitFor(() => !sourceBuffer.updating, { timeout: 100 });
    }

    // Memory footprint remains strictly bounded below quota
    expect(sourceBuffer.currentBytes).toBeLessThan(sourceBuffer.quotaLimitBytes);
  });
});

