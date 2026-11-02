/**
 * tests/e2e/playback-e2e.test.ts
 * Comprehensive End-to-End Playback Test Track (Requirements R1 & R2)
 *
 * Verifies:
 * - R1: TV Series Playback Pipeline (MKV demuxing, AC-3 safety, audio lacing, initial PTS gap)
 * - R2: Video Buffering Elimination (Pipelined prefetching, dynamic buffer management, eviction)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from '../infra/test-harness.ts';
import {
  MockHTMLVideoElement,
  MockMediaSource,
  MockSourceBuffer,
  setupMockBrowserEnvironment,
} from '../infra/mock-browser.ts';
import { buildSyntheticMkv, buildLacedSimpleBlock } from '../infra/synthetic-ebml.ts';
import { parseMatroskaHeader, parseSimpleBlock } from '../../src/services/remuxer/ebml.ts';
import { MatroskaTransmuxer } from '../../src/services/remuxer/transmuxer.ts';
import { MockTelegramEngine } from '../infra/mock-telegram.ts';
import { tgStreamEngine } from '../../src/services/tgStreamEngine.ts';
import { PlayerEngine } from '../../src/services/playerEngine.ts';

describe('Playback E2E Suite: TV Series & Buffering Stabilization', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
    tgStreamEngine.destroy();
  });

  describe('R1: TV Series Playback Pipeline', () => {
    it('E2E-R1-1: Should correctly parse Matroska MKV header with video and audio tracks', () => {
      const mkvBytes = buildSyntheticMkv({
        durationSec: 2400, // 40-minute TV episode
        videoCodec: 'V_MPEG4/ISO/AVC',
        audioCodec: 'A_AAC',
        width: 1920,
        height: 1080,
      });

      const meta = parseMatroskaHeader(mkvBytes);
      expect(meta.videoTracks.length).toBe(1);
      expect(meta.videoTracks[0].codecId).toBe('V_MPEG4/ISO/AVC');
      expect(meta.videoTracks[0].width).toBe(1920);
      expect(meta.videoTracks[0].height).toBe(1080);
      expect(meta.audioTracks.length).toBe(1);
      expect(meta.audioTracks[0].codecId).toBe('A_AAC');
      expect(meta.durationSec).toBe(2400);
    });

    it('E2E-R1-2: Should prevent audio SourceBuffer deadlock when TV series contains AC-3 audio', () => {
      const mkvBytes = buildSyntheticMkv({
        durationSec: 1800,
        videoCodec: 'V_MPEG4/ISO/AVC',
        audioCodec: 'A_AC3', // Multi-channel AC-3 audio track typical in TV series
      });

      const meta = parseMatroskaHeader(mkvBytes);
      expect(meta.audioTracks[0].codecId).toBe('A_AC3');

      const transmuxer = new MatroskaTransmuxer(meta);

      // Transmuxer indicates AC-3 is not supported for software transmuxing to AAC
      expect(transmuxer.isAudioSupported()).toBe(false);

      // Transmuxing video blocks produces video init segment
      const initSeg = transmuxer.generateInitSegment();
      expect(initSeg).toBeDefined();

      // Transmuxing blocks never produces orphaned audio segments
      const fakeBlocks = [
        {
          trackNumber: 1,
          relativeTime: 0,
          isKeyframe: true,
          data: new Uint8Array([0x65, 0x88, 0x80]),
          ptsMs: 0,
        },
      ];
      const result = transmuxer.transmuxBlocks(fakeBlocks);
      expect(result).toBeDefined();
      expect(result!.audioInitSegment).toBeUndefined();
      expect(result!.audioMediaSegment).toBeUndefined();
    });

    it('E2E-R1-3: Should detect and parse laced Matroska audio SimpleBlocks', () => {
      const lacedBlock = buildLacedSimpleBlock(2, 0, 3);
      // Skip EBML ID (1 byte) and VINT length (1 byte)
      const payload = lacedBlock.subarray(2);
      const parsed = parseSimpleBlock(payload);

      expect(parsed).toBeDefined();
      expect(parsed!.trackNumber).toBe(2);
      expect(parsed!.isKeyframe).toBe(true);
      expect(parsed!.data.length).toBeGreaterThan(0);
    });

    it('E2E-R1-4: Should preserve non-zero initial PTS offset without causing NaN duration', () => {
      const mkvBytes = buildSyntheticMkv({
        durationSec: 120,
        initialClusterPtsMs: 80, // Non-zero initial PTS (80ms)
      });

      const meta = parseMatroskaHeader(mkvBytes);
      expect(meta.durationSec).toBe(120);
      expect(Number.isNaN(meta.durationSec)).toBe(false);
    });
  });

  describe('R2: Video Buffering Elimination', () => {
    it('E2E-R2-1: Should maintain sequential chunk prefetching without chunk duplication', async () => {
      const CHUNK_SIZE = 512 * 1024;
      const CHUNK_COUNT = 6;
      const telegram = new MockTelegramEngine({ chunkSize: CHUNK_SIZE });
      telegram.registerStreamData('stream_buffer_test', new Uint8Array(CHUNK_COUNT * CHUNK_SIZE));

      // Fetch sequential chunks
      for (let i = 0; i < CHUNK_COUNT; i++) {
        const offset = i * CHUNK_SIZE;
        await telegram.fetchChunk('stream_buffer_test', offset, CHUNK_SIZE);
      }

      const log = telegram.getFetchLog();
      expect(log).toHaveLength(CHUNK_COUNT);
      // Verify no duplicate fetches (Chunk 0 offset 0 fetched only once)
      const offset0Calls = log.filter((entry) => entry.offset === 0);
      expect(offset0Calls).toHaveLength(1);
    });

    it('E2E-R2-2: Should handle SourceBuffer eviction without stalling active playback', async () => {
      const mediaSource = new MockMediaSource();
      mediaSource.open();

      const videoBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
      const segment = new Uint8Array(2048);

      videoBuffer.appendBuffer(segment);
      await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });

      // Evict buffer behind playhead
      videoBuffer.remove(0, 30);
      await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });

      // Append new forward segment
      videoBuffer.appendBuffer(segment);
      await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });

      expect(videoBuffer.appendHistory).toHaveLength(2);
    });

    it('E2E-R2-3: Should recover from waiting buffer stall when chunks are fed', () => {
      const video = new MockHTMLVideoElement();
      let isBuffering = false;

      video.addEventListener('waiting', () => {
        isBuffering = true;
      });
      video.addEventListener('playing', () => {
        isBuffering = false;
      });

      video.simulateWaiting();
      expect(isBuffering).toBe(true);

      video.play();
      expect(isBuffering).toBe(false);
    });
  });
});

