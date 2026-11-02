import { useState, useEffect, useCallback, useRef } from 'react';

export function useSpatialNavigation() {
  const [isTvMode, setIsTvMode] = useState<boolean>(false);
  const [currentFocusId, setCurrentFocusId] = useState<string | null>(null);
  const registeredElements = useRef<Map<string, HTMLElement>>(new Map());

  // Detect TV User Agent (webOS TV / Tizen / Android TV)
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isSmartTv = /webos|smarttv|appletv|googletv|tizen|crkey|hbbtv/i.test(ua);
    if (isSmartTv) {
      setIsTvMode(true);
    }
  }, []);

  const registerNavElement = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      registeredElements.current.set(id, el);
    } else {
      registeredElements.current.delete(id);
    }
  }, []);

  const setFocus = useCallback((id: string) => {
    const el = registeredElements.current.get(id);
    if (el) {
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      setCurrentFocusId(id);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Any arrow key or TV remote key activates TV navigation mode
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
        if (!isTvMode) setIsTvMode(true);
      }

      // If active element is an input, don't hijack arrows
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl) return;

      const group = activeEl.getAttribute('data-nav-group');
      const indexStr = activeEl.getAttribute('data-nav-index');
      if (!group || indexStr === null) return;

      const index = parseInt(indexStr, 10);

      if (e.key === 'ArrowRight') {
        const next = document.querySelector(`[data-nav-group="${group}"][data-nav-index="${index + 1}"]`) as HTMLElement;
        if (next) {
          e.preventDefault();
          next.focus();
          next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      } else if (e.key === 'ArrowLeft') {
        const prev = document.querySelector(`[data-nav-group="${group}"][data-nav-index="${index - 1}"]`) as HTMLElement;
        if (prev) {
          e.preventDefault();
          prev.focus();
          prev.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      } else if (e.key === 'ArrowDown') {
        const rowOrder = activeEl.getAttribute('data-nav-row');
        if (rowOrder !== null) {
          const nextRowOrder = parseInt(rowOrder, 10) + 1;
          const nextRowEl = document.querySelector(`[data-nav-row="${nextRowOrder}"][data-nav-index="0"]`) as HTMLElement;
          if (nextRowEl) {
            e.preventDefault();
            nextRowEl.focus();
            nextRowEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          }
        }
      } else if (e.key === 'ArrowUp') {
        const rowOrder = activeEl.getAttribute('data-nav-row');
        if (rowOrder !== null) {
          const prevRowOrder = parseInt(rowOrder, 10) - 1;
          const prevRowEl = document.querySelector(`[data-nav-row="${prevRowOrder}"][data-nav-index="0"]`) as HTMLElement;
          if (prevRowEl) {
            e.preventDefault();
            prevRowEl.focus();
            prevRowEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          }
        }
      }
    };

    const handleMouseMove = () => {
      // If user moves mouse on desktop, keep TV focus subtle
      if (isTvMode && !/webos|smarttv|tizen/i.test(navigator.userAgent.toLowerCase())) {
        setIsTvMode(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isTvMode]);

  return {
    isTvMode,
    setIsTvMode,
    currentFocusId,
    setFocus,
    registerNavElement,
  };
}

