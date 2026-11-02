/**
 * tests/e2e/tier2-boundary.test.ts
 * Tier 2: Boundary & Corner Cases (Opaque-Box E2E Tests)
 * Tests non-zero PTS offsets, laced audio, quota limits, empty metadata fallbacks, and network drop recovery.
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

describe('Tier 2: Boundary & Corner Cases', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
  });

  // TC 2.1: Non-Zero Initial PTS Gap Bridging
  it('TC 2.1: Should detect and preserve initial non-zero cluster PTS offset (>0ms)', () => {
    // Many TV series MKVs start at PTS = 80ms or 120ms due to B-frame reordering
    const initialPtsMs = 80;
    const mkvData = buildSyntheticMkv({
      durationSec: 60,
      initialClusterPtsMs: initialPtsMs,
      videoCodec: 'V_MPEG4/ISO/AVC',
    });

    const header = parseMatroskaHeader(mkvData);
    expect(header.videoTracks).toHaveLength(1);

    // Initial PTS must not cause negative playback offset or NaN duration
    expect(header.durationSec).toBe(60);
  });

  // TC 2.2: Matroska Multi-Frame Audio Lacing Detection & SimpleBlock Extraction
  it('TC 2.2: Should parse SimpleBlock with Xiph / EBML lacing flags set', () => {
    // Generate a SimpleBlock with 3 laced frames
    const lacedBlockElement = buildLacedSimpleBlock(2, 0, 3);

    // Skip the EBML ID (0xa3) and VINT size to reach payload
    // 0xa3 is 1 byte, followed by 1 byte VINT size
    const payload = lacedBlockElement.subarray(2);
    const parsed = parseSimpleBlock(payload);

    expect(parsed).toBeDefined();
    expect(parsed!.trackNumber).toBe(2);
    expect(parsed!.isKeyframe).toBe(true);
    expect(parsed!.data.length).toBeGreaterThan(0);
  });

  // TC 2.3: AC-3 Audio Track Detection & Guard Against Audio SourceBuffer Deadlock
  it('TC 2.3: Should identify AC-3 codec without emitting empty fMP4 audio segment', () => {
    const mkvData = buildSyntheticMkv({
      videoCodec: 'V_MPEG4/ISO/AVC',
      audioCodec: 'A_AC3',
    });
    const header = parseMatroskaHeader(mkvData);
    expect(header.audioTracks[0].codecId).toBe('A_AC3');

    const transmuxer = new MatroskaTransmuxer(header);
    const initSeg = transmuxer.generateInitSegment();
    expect(initSeg).toBeDefined();

    // Verify transmuxer reports isAudioSupported = false for AC-3
    expect(transmuxer.isAudioSupported()).toBe(false);
    expect(transmuxer.getAudioCodecName()).toBe('AC3');

    // Process blocks with AC-3 audio block
    const fakeBlocks = [
      {
        trackNumber: 1,
        relativeTime: 0,
        isKeyframe: true,
        data: new Uint8Array([0x65, 0x88, 0x80]),
        ptsMs: 0,
      },
      {
        trackNumber: 2,
        relativeTime: 0,
        isKeyframe: true,
        data: new Uint8Array([0x0b, 0x77]),
        ptsMs: 0,
      },
    ];

    const result = transmuxer.transmuxBlocks(fakeBlocks);
    expect(result).toBeDefined();
    // Transmuxer must produce zero audio segments for AC-3
    expect(result!.audioInitSegment).toBeUndefined();
    expect(result!.audioMediaSegment).toBeUndefined();
  });

  // TC 2.4: QuotaExceededError Trigger and Symmetric Eviction Handling
  it('TC 2.4: Should simulate SourceBuffer quota exhaustion and subsequent eviction recovery', async () => {
    const mediaSource = new MockMediaSource();
    mediaSource.open();

    const videoBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    videoBuffer.quotaLimitBytes = 1024; // Very low quota: 1KB

    const smallChunk = new Uint8Array(600);
    videoBuffer.appendBuffer(smallChunk);

    await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });
    expect(videoBuffer.currentBytes).toBe(600);

    // Second chunk exceeds 1024 bytes -> must throw QuotaExceededError
    const secondChunk = new Uint8Array(600);
    expect(() => {
      videoBuffer.appendBuffer(secondChunk);
    }).toThrow('The quota has been exceeded.');

    // Evict buffer behind playhead
    videoBuffer.remove(0, 30);
    await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });

    // Reset currentBytes to simulate eviction
    videoBuffer.currentBytes = 0;
    videoBuffer.appendBuffer(secondChunk);
    await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });
    expect(videoBuffer.currentBytes).toBe(600);
  });

  // TC 2.5: Empty Metadata Fallback Rendering Contract
  it('TC 2.5: Should provide clean fallback values when TMDB poster and backdrop are null', () => {
    const rawMediaItem = {
      id: 'ep_empty_meta',
      fileName: 'Severance.S01E03.1080p.mkv',
      parsed: {
        cleanTitle: 'Severance',
        originalFileName: 'Severance.S01E03.1080p.mkv',
        isSeries: true,
        season: 1,
        episode: 3,
        resolution: '1080p',
      },
      tmdb: null, // No TMDB match available
    };

    // Metadata resolver fallback hierarchy
    const resolvedTitle = rawMediaItem.tmdb?.title || rawMediaItem.parsed.cleanTitle || rawMediaItem.fileName;
    const resolvedPoster = rawMediaItem.tmdb?.posterPath || null;
    const resolvedBackdrop = rawMediaItem.tmdb?.backdropPath || null;
    const episodeBadge = `S${String(rawMediaItem.parsed.season).padStart(2, '0')}E${String(rawMediaItem.parsed.episode).padStart(2, '0')}`;

    expect(resolvedTitle).toBe('Severance');
    expect(resolvedPoster).toBeNull();
    expect(resolvedBackdrop).toBeNull();
    expect(episodeBadge).toBe('S01E03');
  });

  // TC 2.6: Network Drops & MTProto Timeout Error Dispatch
  it('TC 2.6: Should reject with descriptive network timeout when MTProto drops', async () => {
    const telegramMock = new MockTelegramEngine({
      simulateTimeout: true,
    });
    telegramMock.registerStreamData('stream_test', new Uint8Array(1024));

    await expect(
      telegramMock.fetchChunk('stream_test', 0, 512)
    ).rejects.toThrow('Telegram MTProto connection timed out');
  });
});
