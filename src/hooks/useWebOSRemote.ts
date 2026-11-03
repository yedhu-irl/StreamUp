import { useEffect } from 'react';

export interface WebOSRemoteHandlers {
  onBack?: () => boolean | void; // return true if handled, false to pass to default
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onFastForward?: () => void;
  onRewind?: () => void;
}

// LG webOS Remote key codes
export const WEBOS_KEYS = {
  BACK: 461,
  PLAY: 415,
  PAUSE: 19,
  STOP: 413,
  FAST_FORWARD: 417,
  REWIND: 412,
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
};

export function isWebOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /web0s|webos/i.test(ua) || typeof (window as any).webOS !== 'undefined';
}

export function useWebOSRemote(handlers: WebOSRemoteHandlers) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const code = e.keyCode || e.which;

      // 1. Back button (LG webOS keycode 461 or GoBack or Escape)
      if (code === WEBOS_KEYS.BACK || e.key === 'GoBack' || e.key === 'Escape') {
        if (handlers.onBack) {
          const handled = handlers.onBack();
          if (handled !== false) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }

      // 2. Play / Pause / Media keys
      if (code === WEBOS_KEYS.PLAY || e.key === 'MediaPlay') {
        if (handlers.onPlay) {
          e.preventDefault();
          handlers.onPlay();
        }
      } else if (code === WEBOS_KEYS.PAUSE || e.key === 'MediaPause') {
        if (handlers.onPause) {
          e.preventDefault();
          handlers.onPause();
        }
      } else if (code === WEBOS_KEYS.STOP || e.key === 'MediaStop') {
        if (handlers.onStop) {
          e.preventDefault();
          handlers.onStop();
        }
      } else if (code === WEBOS_KEYS.FAST_FORWARD || e.key === 'MediaFastForward') {
        if (handlers.onFastForward) {
          e.preventDefault();
          handlers.onFastForward();
        }
      } else if (code === WEBOS_KEYS.REWIND || e.key === 'MediaRewind') {
        if (handlers.onRewind) {
          e.preventDefault();
          handlers.onRewind();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handlers]);
}

