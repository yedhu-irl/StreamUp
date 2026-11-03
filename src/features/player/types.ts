// src/features/player/types.ts
import type { ChannelVideoItem } from '../../types';

export interface PlayerErrorDetails {
  code: 'NETWORK_TIMEOUT' | 'MEDIA_DECODE_ERROR' | 'UNSUPPORTED_FORMAT' | 'BUFFER_EXHAUSTED' | 'STREAM_STALL' | 'UNKNOWN';
  title: string;
  message: string;
  technicalDetails?: string;
  recoverable: boolean;
}

export interface PlayerErrorOverlayProps {
  media?: ChannelVideoItem | null;
  error: PlayerErrorDetails | string | null;
  onRetry: () => void;
  onClose: () => void;
  onPlayNext?: () => void;
  nextEpisode?: ChannelVideoItem | null;
}

/**
 * Translates low-level engine, network, or browser exceptions into clear,
 * human-readable explanations categorized by error type with technical details.
 */
export function translatePlayerError(rawError: any): PlayerErrorDetails {
  if (!rawError) {
    return {
      code: 'UNKNOWN',
      title: 'Playback Error',
      message: 'An unexpected error occurred during playback.',
      recoverable: true,
    };
  }

  if (typeof rawError === 'object' && rawError.code && rawError.title && rawError.message) {
    return rawError as PlayerErrorDetails;
  }

  const errStr = typeof rawError === 'string' ? rawError : rawError?.message || String(rawError);

  // Telegram Media Auth Key / Session Expiration
  if (
    errStr.includes('AUTH_KEY_UNREGISTERED') ||
    errStr.includes('AUTH_KEY_DUPLICATED') ||
    errStr.includes('SESSION_REVOKED') ||
    errStr.includes('401')
  ) {
    return {
      code: 'NETWORK_TIMEOUT',
      title: 'Media Authorization Refreshing',
      message: 'Telegram media key expired. Re-authorizing and retrying stream...',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  // Network timeout / connection loss
  if (
    errStr.includes('timed out') ||
    errStr.includes('FLOOD_WAIT') ||
    errStr.includes('socket closed') ||
    errStr.includes('timeout') ||
    errStr.includes('NetworkError') ||
    errStr.includes('MEDIA_ERR_NETWORK')
  ) {
    return {
      code: 'NETWORK_TIMEOUT',
      title: 'Connection Lost',
      message: 'Unable to connect to media server. Please check your network and internet connection.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  // Unsupported codec / format failure
  if (
    errStr.includes('MEDIA_ERR_SRC_NOT_SUPPORTED') ||
    errStr.includes('not supported') ||
    errStr.includes('codec') ||
    errStr.includes('hev1') ||
    errStr.includes('hvc1')
  ) {
    return {
      code: 'UNSUPPORTED_FORMAT',
      title: 'Unsupported Media Format',
      message: 'Video codec is not supported by your browser.',
      technicalDetails: errStr,
      recoverable: false,
    };
  }

  // Hardware / video decode error
  if (
    errStr.includes('MEDIA_ERR_DECODE') ||
    errStr.includes('decoding error') ||
    errStr.includes('decode') ||
    errStr.includes('NALU')
  ) {
    return {
      code: 'MEDIA_DECODE_ERROR',
      title: 'Video Decode Error',
      message: 'Video codec is not supported by your browser.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  // Buffer exhaustion
  if (errStr.includes('QuotaExceededError') || errStr.includes('quota') || errStr.includes('buffer exhausted')) {
    return {
      code: 'BUFFER_EXHAUSTED',
      title: 'Buffer Storage Full',
      message: 'Playback stalled due to an interrupted data stream.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  // Stream stall / buffer starvation
  if (errStr.includes('stalled') || errStr.includes('Stall') || errStr.includes('STALL_WATCHDOG')) {
    return {
      code: 'STREAM_STALL',
      title: 'Playback Stalled',
      message: 'Playback stalled due to an interrupted data stream.',
      technicalDetails: errStr,
      recoverable: true,
    };
  }

  // Media unavailable
  if (
    errStr.includes('could not be found') ||
    errStr.includes('not found') ||
    errStr.includes('locate video file') ||
    errStr.includes('unavailable') ||
    errStr.includes('404')
  ) {
    return {
      code: 'UNKNOWN',
      title: 'Media Unavailable',
      message: 'The requested stream file could not be found.',
      technicalDetails: errStr,
      recoverable: false,
    };
  }

  // General failure fallback
  return {
    code: 'UNKNOWN',
    title: 'Playback Error',
    message: 'An unexpected error occurred during playback.',
    technicalDetails: errStr,
    recoverable: true,
  };
}
