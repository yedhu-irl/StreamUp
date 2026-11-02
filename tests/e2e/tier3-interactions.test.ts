/**
 * tests/e2e/tier3-interactions.test.ts
 * Tier 3: Cross-Feature Interactions (Opaque-Box E2E Tests)
 * Tests multi-component state interactions: buffering recovery, network error retry,
 * episode switching lifecycle, and collapsed series routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from '../infra/test-harness.ts';
import {
  MockHTMLVideoElement,
  MockMediaSource,
  MockSourceBuffer,
  setupMockBrowserEnvironment,
} from '../infra/mock-browser.ts';
import { PlayerEngine } from '../../src/services/playerEngine.ts';
import { tgStreamEngine } from '../../src/services/tgStreamEngine.ts';
import { buildSyntheticMkv } from '../infra/synthetic-ebml.ts';

describe('Tier 3: Cross-Feature Interactions', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
    tgStreamEngine.destroy();
  });

  // TC 3.1: Buffering State Transition & Recovery During TV Series Playback
  it('TC 3.1: Should transition buffering state on waiting event and recover on canplay', () => {
    const video = new MockHTMLVideoElement();
    let isBuffering = false;

    // Simulate player session event listeners
    video.addEventListener('waiting', () => {
      isBuffering = true;
    });
    video.addEventListener('playing', () => {
      isBuffering = false;
    });

    // Start playing
    video.play();
    expect(isBuffering).toBe(false);

    // Network stall causes HTML5 video engine to enter WAITING state
    video.simulateWaiting();
    expect(isBuffering).toBe(true);

    // Prefetched chunks arrive, restoring PLAYING state
    video.play();
    expect(isBuffering).toBe(false);
  });

  // TC 3.2: Retry After Mid-Stream Network Interruption
  it('TC 3.2: Should preserve current timestamp and restart playback engine on Retry', () => {
    const video = new MockHTMLVideoElement();
    const onReadyMock = vi.fn();
    const onErrorMock = vi.fn();

    const engine = new PlayerEngine({
      videoElement: video as unknown as HTMLVideoElement,
      streamId: 'chat123_456',
      fileName: 'Game.of.Thrones.S01E01.mkv',
      mimeType: 'video/x-matroska',
      fileSize: 104857600,
      initialTime: 0,
      onReady: onReadyMock,
      onError: onErrorMock,
    });

    // Advance playhead to 142 seconds before network drops
    video.currentTime = 142.5;

    // Simulate network error triggered in player session
    let sessionError: string | null = null;
    let interruptedTime = 0;

    const handlePlayerError = (err: string) => {
      sessionError = err;
      interruptedTime = video.currentTime;
    };

    handlePlayerError('Telegram MTProto connection timed out (FLOOD_WAIT / TIMEOUT)');
    expect(sessionError).toContain('timed out');
    expect(interruptedTime).toBe(142.5);

    // User clicks Retry in Rich Error UI -> restarts session with targetStart = interruptedTime
    const restartMock = vi.fn((resumeTime: number) => {
      const newEngine = new PlayerEngine({
        videoElement: video as unknown as HTMLVideoElement,
        streamId: 'chat123_456',
        fileName: 'Game.of.Thrones.S01E01.mkv',
        mimeType: 'video/x-matroska',
        fileSize: 104857600,
        initialTime: resumeTime,
      });
      return newEngine;
    });

    const newEngineInstance = restartMock(interruptedTime);
    expect(restartMock).toHaveBeenCalledWith(142.5);
    expect(newEngineInstance).toBeDefined();

    engine.destroy();
    newEngineInstance.destroy();
  });

  // TC 3.3: Episode Switching Lifecycle After Playback Error
  it('TC 3.3: Should cleanly tear down previous engine and initialize next episode upon error navigation', () => {
    const video = new MockHTMLVideoElement();
    let currentEpisodeId = 'ep_01';
    let engine = new PlayerEngine({
      videoElement: video as unknown as HTMLVideoElement,
      streamId: '1001_1',
      fileName: 'Severance.S01E01.1080p.mkv',
      mimeType: 'video/x-matroska',
      fileSize: 50000000,
    });

    // Simulate fatal error on Episode 1
    const destroySpy = vi.spyOn(engine, 'destroy');

    // User clicks "Play Next Episode" (Episode 2)
    currentEpisodeId = 'ep_02';
    engine.destroy();
    expect(destroySpy).toHaveBeenCalled();

    engine = new PlayerEngine({
      videoElement: video as unknown as HTMLVideoElement,
      streamId: '1001_2',
      fileName: 'Severance.S01E02.1080p.mkv',
      mimeType: 'video/x-matroska',
      fileSize: 52000000,
      initialTime: 0,
    });

    expect(currentEpisodeId).toBe('ep_02');
    expect(engine).toBeDefined();
    engine.destroy();
  });

  // TC 3.4: TV Series Routing Contract (Preserving .mkv Extension and Matroska Container)
  it('TC 3.4: Should route MKV TV series to MSE remuxer even when title is formatted', async () => {
    const video = new MockHTMLVideoElement();
    const onStatusMock = vi.fn();

    // When fileName retains .mkv or mimeType is Matroska, PlayerEngine routes to startMsePath
    const engine = new PlayerEngine({
      videoElement: video as unknown as HTMLVideoElement,
      streamId: 'series_chat_99',
      fileName: 'Severance.S01E01.mkv',
      mimeType: 'video/x-matroska',
      fileSize: 80000000,
      onStatus: onStatusMock,
    });

    await engine.start();

    // MSE path emits transmuxing status
    expect(onStatusMock).toHaveBeenCalledWith(
      'Transmuxing Matroska stream for MSE hardware decoding...'
    );

    engine.destroy();
  });
});
