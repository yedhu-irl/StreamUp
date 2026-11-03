import React, { useRef, useState, useCallback, useMemo } from 'react';
import type { ByteRange } from '../services/windowPlanner';

interface PlayerTimebarProps {
  currentTime: number;
  duration: number;
  totalSize?: number;
  bufferedRanges?: Array<{ start: number; end: number }>;
  downloadedRanges?: ByteRange[];
  bookmarks?: Array<{ id: string; timeSec: number; note: string }>;
  onSeek: (targetSec: number) => void;
  onPreviewChange?: (previewSec: number | null) => void;
}

export const PlayerTimebar: React.FC<PlayerTimebarProps> = ({
  currentTime,
  duration,
  totalSize = 0,
  bufferedRanges,
  downloadedRanges = [],
  bookmarks = [],
  onSeek,
  onPreviewChange,
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);

  const formatTime = (sec: number): string => {
    if (isNaN(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getTimeFromEvent = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | MouseEvent): number | null => {
      if (!barRef.current || duration <= 0) return null;
      const rect = barRef.current.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return pos * duration;
    },
    [duration]
  );

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const time = getTimeFromEvent(e);
    if (time !== null && barRef.current) {
      const rect = barRef.current.getBoundingClientRect();
      setHoverX(e.clientX - rect.left);
      setHoverTime(time);
      onPreviewChange?.(time);
    }
  };

  const handleMouseLeave = () => {
    if (!isScrubbing) {
      setHoverTime(null);
      onPreviewChange?.(null);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsScrubbing(true);
    const time = getTimeFromEvent(e);
    if (time !== null) {
      onSeek(time);
    }

    const onGlobalMove = (ev: MouseEvent) => {
      const t = getTimeFromEvent(ev);
      if (t !== null && barRef.current) {
        const rect = barRef.current.getBoundingClientRect();
        setHoverX(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)));
        setHoverTime(t);
        onSeek(t);
      }
    };

    const onGlobalUp = (ev: MouseEvent) => {
      setIsScrubbing(false);
      setHoverTime(null);
      onPreviewChange?.(null);
      window.removeEventListener('mousemove', onGlobalMove);
      window.removeEventListener('mouseup', onGlobalUp);
      const finalTime = getTimeFromEvent(ev);
      if (finalTime !== null) {
        onSeek(finalTime);
      }
    };

    window.addEventListener('mousemove', onGlobalMove);
    window.addEventListener('mouseup', onGlobalUp);
  };

  // Convert buffered time ranges (or downloaded byte ranges) to visual percentages (YouTube model)
  const rangeSegments = useMemo(() => {
    if (bufferedRanges && bufferedRanges.length > 0 && duration > 0) {
      return bufferedRanges.map((r) => {
        const left = Math.max(0, Math.min(100, (r.start / duration) * 100));
        const width = Math.max(0, Math.min(100 - left, ((r.end - r.start) / duration) * 100));
        return { left, width };
      });
    }
    if (totalSize > 0 && downloadedRanges && downloadedRanges.length > 0) {
      return downloadedRanges.map((r) => {
        const left = Math.max(0, Math.min(100, (r.start / totalSize) * 100));
        const width = Math.max(0, Math.min(100 - left, ((r.end - r.start) / totalSize) * 100));
        return { left, width };
      });
    }
    return [];
  }, [bufferedRanges, duration, downloadedRanges, totalSize]);

  const playedPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div
      ref={barRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      className="relative w-full h-8 flex items-center cursor-pointer group select-none touch-none"
    >
      {/* Time Hover Balloon */}
      {hoverTime !== null && (
        <div
          className="absolute -top-10 -translate-x-1/2 px-2.5 py-1 rounded-lg bg-[#18181c] border border-white/20 text-[11px] font-mono font-bold text-white shadow-xl pointer-events-none z-30"
          style={{ left: `${hoverX}px` }}
        >
          {formatTime(hoverTime)}
        </div>
      )}

      {/* Scrubber Track Container */}
      <div className="relative w-full h-1.5 group-hover:h-2.5 rounded-full bg-white/15 overflow-hidden transition-all duration-200">
        {/* Layer 2: YouTube-style Buffered Ranges (Gray bar) */}
        {rangeSegments.map((seg, idx) => (
          <div
            key={idx}
            className="absolute top-0 bottom-0 bg-white/40 group-hover:bg-white/50 transition-all duration-200"
            style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
          />
        ))}

        {/* Layer 3: Played Progress */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-white group-hover:bg-amber-400 transition-colors rounded-full"
          style={{ width: `${playedPercent}%` }}
        />

        {/* Bookmark Markers */}
        {bookmarks.map((bm) => {
          const bmPercent = duration > 0 ? (bm.timeSec / duration) * 100 : 0;
          return (
            <div
              key={bm.id}
              className="absolute top-0 bottom-0 w-1 bg-amber-400 z-10"
              style={{ left: `${bmPercent}%` }}
              title={bm.note || `Bookmark at ${formatTime(bm.timeSec)}`}
            />
          );
        })}
      </div>

      {/* Scrub Thumb */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 group-hover:w-4 group-hover:h-4 rounded-full bg-white shadow-lg pointer-events-none scale-0 group-hover:scale-100 transition-all duration-150 ring-2 ring-white/40"
        style={{ left: `${playedPercent}%` }}
      />
    </div>
  );
};

