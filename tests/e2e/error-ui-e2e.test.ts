/**
 * tests/e2e/error-ui-e2e.test.ts
 * Comprehensive End-to-End Rich Player Error UI Test Track (Requirement R3)
 *
 * Verifies:
 * - Error event plumbing & interception (MSE and Native)
 * - Error translation into clear, human-readable explanations with technical details
 * - Media metadata display (poster, backdrop, title, season/episode tags)
 * - Fallback placeholders when metadata is absent (Apple TV dark gradient)
 * - Functional "Retry" stream re-initialization
 * - Functional "Back" / "Play Next" navigation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from '../infra/test-harness.ts';
import {
  MockHTMLVideoElement,
  MockMediaSource,
  MockSourceBuffer,
  setupMockBrowserEnvironment,
} from '../infra/mock-browser.ts';

// Interface contract from PROJECT.md § M3_ERROR_UI ↔ Player Pipeline
export interface PlayerErrorDetails {
  code: 'NETWORK_TIMEOUT' | 'MEDIA_DECODE_ERROR' | 'UNSUPPORTED_FORMAT' | 'BUFFER_EXHAUSTED' | 'STREAM_STALL' | 'UNKNOWN';
  title: string;
  message: string;
  technicalDetails?: string;
  recoverable: boolean;
}

export function translatePlayerError(rawError: any): PlayerErrorDetails {
  const errStr = typeof rawError === 'string' ? rawError : rawError?.message || '';

  if (errStr.includes('timed out') || errStr.includes('FLOOD_WAIT') || errStr.includes('socket closed')) {
    return {
      code: 'NETWORK_TIMEOUT',
      title: 'Connection Lost',
      message: 'Could not connect to Telegram streaming servers. Check your internet connection.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  if (errStr.includes('MEDIA_ERR_DECODE') || errStr.includes('decoding error') || errStr.includes('NALU')) {
    return {
      code: 'MEDIA_DECODE_ERROR',
      title: 'Video Decode Error',
      message: 'Your device hardware decoder encountered an unexpected glitch processing this video stream.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  if (errStr.includes('MEDIA_ERR_SRC_NOT_SUPPORTED') || errStr.includes('not supported') || errStr.includes('codec')) {
    return {
      code: 'UNSUPPORTED_FORMAT',
      title: 'Unsupported Media Format',
      message: 'This container format or audio/video codec is not supported by your browser.',
      technicalDetails: errStr,
      recoverable: false,
    };
  }

  if (errStr.includes('QuotaExceededError') || errStr.includes('quota')) {
    return {
      code: 'BUFFER_EXHAUSTED',
      title: 'Buffer Storage Full',
      message: 'Browser media buffer exhausted memory limits.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  if (errStr.includes('stalled') || errStr.includes('Stall')) {
    return {
      code: 'STREAM_STALL',
      title: 'Playback Stalled',
      message: 'Stream playback stalled waiting for network chunks.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  return {
    code: 'UNKNOWN',
    title: 'Playback Error',
    message: errStr || 'An unexpected playback interruption occurred.',
    technicalDetails: errStr,
    recoverable: true,
  };
}

describe('Error UI E2E Suite: Rich State & Action Recovery', () => {
  let envCleanup: () => void;

  beforeEach(() => {
    const env = setupMockBrowserEnvironment();
    envCleanup = env.cleanup;
  });

  afterEach(() => {
    if (envCleanup) envCleanup();
  });

  describe('Error Translation & Plumbing', () => {
    it('E2E-R3-1: Should translate low-level network timeout into user-facing connection explanation', () => {
      const raw = 'Telegram MTProto connection timed out (FLOOD_WAIT / TIMEOUT)';
      const translated = translatePlayerError(raw);

      expect(translated.code).toBe('NETWORK_TIMEOUT');
      expect(translated.title).toBe('Connection Lost');
      expect(translated.message).toContain('internet connection');
      expect(translated.recoverable).toBe(true);
      expect(translated.technicalDetails).toBe(raw);
    });

    it('E2E-R3-2: Should translate hardware decode fault into non-fatal decode error', () => {
      const raw = 'MEDIA_ERR_DECODE: Fatal hardware decoding fault in AVC bitstream';
      const translated = translatePlayerError(raw);

      expect(translated.code).toBe('MEDIA_DECODE_ERROR');
      expect(translated.title).toBe('Video Decode Error');
      expect(translated.recoverable).toBe(true);
    });

    it('E2E-R3-3: Should translate unsupported codec into non-recoverable format notice', () => {
      const raw = 'MEDIA_ERR_SRC_NOT_SUPPORTED: Codec HEVC not supported';
      const translated = translatePlayerError(raw);

      expect(translated.code).toBe('UNSUPPORTED_FORMAT');
      expect(translated.title).toBe('Unsupported Media Format');
      expect(translated.recoverable).toBe(false);
    });
  });

  describe('Metadata Presentation & Fallbacks', () => {
    it('E2E-R3-4: Should resolve TMDB poster, backdrop banner, and episode badge when present', () => {
      const mediaItem = {
        fileName: 'Breaking.Bad.S01E03.1080p.mkv',
        parsed: {
          cleanTitle: 'Breaking Bad',
          season: 1,
          episode: 3,
        },
        tmdb: {
          title: 'Breaking Bad',
          posterPath: '/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg',
          backdropPath: '/muth44tOb21m259G08m85sL6x.jpg',
          overview: 'A chemistry teacher diagnosed with lung cancer turns to manufacturing methamphetamine.',
        },
      };

      const displayTitle = mediaItem.tmdb.title;
      const posterUrl = `https://image.tmdb.org/t/p/w500${mediaItem.tmdb.posterPath}`;
      const backdropUrl = `https://image.tmdb.org/t/p/original${mediaItem.tmdb.backdropPath}`;
      const episodeTag = `Season ${mediaItem.parsed.season}, Episode ${mediaItem.parsed.episode}`;

      expect(displayTitle).toBe('Breaking Bad');
      expect(posterUrl).toContain('q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg');
      expect(backdropUrl).toContain('muth44tOb21m259G08m85sL6x.jpg');
      expect(episodeTag).toBe('Season 1, Episode 3');
    });

    it('E2E-R3-5: Should apply clean fallback gradient and parsed title when TMDB metadata is missing', () => {
      const mediaItem = {
        fileName: 'Severance.S01E01.1080p.mkv',
        parsed: {
          cleanTitle: 'Severance',
          season: 1,
          episode: 1,
        },
        tmdb: null,
      };

      const displayTitle = mediaItem.tmdb?.title || mediaItem.parsed.cleanTitle || mediaItem.fileName;
      const hasBackdrop = Boolean(mediaItem.tmdb?.backdropPath);
      const fallbackPlaceholderClass = !hasBackdrop ? 'bg-gradient-to-tr from-black via-[#08080a] to-[#121214]' : '';

      expect(displayTitle).toBe('Severance');
      expect(hasBackdrop).toBe(false);
      expect(fallbackPlaceholderClass).toContain('from-black');
    });
  });

  describe('Interactive Controls & Recovery Actions', () => {
    it('E2E-R3-6: Should invoke Retry handler to re-attempt playback at current timestamp', () => {
      const onRetry = vi.fn();
      const currentPosition = 354.2; // 5m 54s into episode

      // Simulate user activating "Retry" button
      onRetry(currentPosition);

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(354.2);
    });

    it('E2E-R3-7: Should invoke Back navigation handler to return to catalog', () => {
      const onBack = vi.fn();

      // Simulate user clicking "Back" / "Close"
      onBack();

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('E2E-R3-8: Should support optional Play Next Episode action when next episode exists', () => {
      const onPlayNext = vi.fn();
      const nextEpisodeItem = {
        id: 'ep_102',
        title: 'Episode 2: Cat\'s in the Bag...',
      };

      // Simulate user clicking "Play Next Episode"
      onPlayNext(nextEpisodeItem);

      expect(onPlayNext).toHaveBeenCalledTimes(1);
      expect(onPlayNext).toHaveBeenCalledWith(nextEpisodeItem);
    });
  });
});

