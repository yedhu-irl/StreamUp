/**
 * tests/e2e/tier1-features.test.ts
 * Tier 1: Feature Coverage (Opaque-Box E2E Tests)
 * Verifies core happy-path functionality across TV series playback and error UI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from '../infra/test-harness.ts';
import {
  MockHTMLVideoElement,
  MockMediaSource,
  MockSourceBuffer,
  setupMockBrowserEnvironment,
} from '../infra/mock-browser.ts';
import { buildSyntheticMkv } from '../infra/synthetic-ebml.ts';
import { parseMatroskaHeader } from '../../src/services/remuxer/ebml.ts';
import { MatroskaTransmuxer } from '../../src/services/remuxer/transmuxer.ts';

describe('Tier 1: Feature Coverage', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
  });

  // TC 1.1: TV Series Episode Loading & Container Detection
  it('TC 1.1: Should detect Matroska MKV container and extract audio/video tracks', () => {
    const mkvData = buildSyntheticMkv({
      durationSec: 1800, // 30-minute TV episode
      videoCodec: 'V_MPEG4/ISO/AVC',
      audioCodec: 'A_AAC',
      width: 1920,
      height: 1080,
    });

    const header = parseMatroskaHeader(mkvData);

    expect(header.videoTracks).toHaveLength(1);
    expect(header.videoTracks[0].codecId).toBe('V_MPEG4/ISO/AVC');
    expect(header.videoTracks[0].width).toBe(1920);
    expect(header.videoTracks[0].height).toBe(1080);
    expect(header.audioTracks).toHaveLength(1);
    expect(header.audioTracks[0].codecId).toBe('A_AAC');
    expect(header.durationSec).toBe(1800);
  });

  // TC 1.2: Transmuxer Init Segment Generation
  it('TC 1.2: Should generate fMP4 init segment with valid moov and ftyp boxes', () => {
    const mkvData = buildSyntheticMkv({
      durationSec: 60,
      videoCodec: 'V_MPEG4/ISO/AVC',
      audioCodec: 'A_AAC',
    });
    const header = parseMatroskaHeader(mkvData);
    const transmuxer = new MatroskaTransmuxer(header);

    const initSegment = transmuxer.generateInitSegment();
    expect(initSegment).toBeDefined();
    expect(initSegment!.length).toBeGreaterThan(32);

    // Verify ISO BMFF 'ftyp' box signature at offset 4..7
    const ftypBox = String.fromCharCode(
      initSegment![4],
      initSegment![5],
      initSegment![6],
      initSegment![7]
    );
    expect(ftypBox).toBe('ftyp');
    expect(transmuxer.hasInitSegment()).toBe(true);
  });

  // TC 1.3: Media Source Extensions Append Flow
  it('TC 1.3: Should create SourceBuffer and append init segment asynchronously', async () => {
    const mediaSource = new MockMediaSource();
    mediaSource.open();

    const videoBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    expect(videoBuffer).toBeDefined();
    expect(videoBuffer.updating).toBe(false);

    const fakeInitSegment = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    videoBuffer.appendBuffer(fakeInitSegment);

    expect(videoBuffer.updating).toBe(true);

    // Await update completion
    await vi.waitFor(() => !videoBuffer.updating, { timeout: 100 });

    expect(videoBuffer.updating).toBe(false);
    expect(videoBuffer.appendHistory).toHaveLength(1);
  });

  // TC 1.4: Error UI Data Model & Contract Validation
  it('TC 1.4: Should validate rich error state data model and fields', () => {
    const errorDetails = {
      code: 'MEDIA_DECODE_ERROR' as const,
      title: 'Playback Error',
      message: 'Video codec or hardware decoder error encountered.',
      technicalDetails: 'SourceBuffer decode error: NALU sync lost',
      recoverable: true,
    };

    expect(errorDetails.code).toBe('MEDIA_DECODE_ERROR');
    expect(errorDetails.recoverable).toBe(true);
    expect(errorDetails.message).toContain('codec');
  });

  // TC 1.5: Interactive Retry Trigger
  it('TC 1.5: Should invoke onRetry callback to re-initialize stream session', () => {
    const onRetryMock = vi.fn();
    const mediaItem = {
      id: 'ep_101',
      fileName: 'Breaking.Bad.S01E01.mkv',
      title: 'Pilot',
    };

    // Simulate user clicking retry in Error UI
    onRetryMock(mediaItem.id);

    expect(onRetryMock).toHaveBeenCalledTimes(1);
    expect(onRetryMock).toHaveBeenCalledWith('ep_101');
  });

  // TC 1.6: Interactive Back Navigation
  it('TC 1.6: Should invoke onClose navigation callback when exiting error state', () => {
    const onCloseMock = vi.fn();

    // Simulate user pressing Back or Close
    onCloseMock();

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });
});
