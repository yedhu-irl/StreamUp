import React, { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChannelVideoItem, WatchProgress } from '../types';
import { MediaCard } from './MediaCard';

interface MediaRowProps {
  title: string;
  items: ChannelVideoItem[];
  onSelect: (item: ChannelVideoItem) => void;
  progressMap?: Map<string, WatchProgress>;
  rowOrder: number;
}

export const MediaRow: React.FC<MediaRowProps> = ({
  title,
  items,
  onSelect,
  progressMap,
  rowOrder,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: 'left' | 'right') => {
    if (rowRef.current) {
      const offset = direction === 'left' ? -650 : 650;
      rowRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  if (!items || items.length === 0) return null;

  return (
    <section className="relative px-6 md:px-10 py-5 group/row">
      {/* Row Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <h2 className="text-xl md:text-2xl font-semibold text-white tracking-tight">
            {title}
          </h2>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-white/10 text-white/70 border border-white/10">
            {items.length}
          </span>
        </div>

        {/* Desktop Scroll Chevrons */}
        <div className="hidden md:flex items-center space-x-1.5 opacity-0 group-hover/row:opacity-100 transition-opacity duration-200">
          <button
            onClick={() => scroll('left')}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-white/80 hover:text-white flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-white"
            title="Scroll Left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-white/80 hover:text-white flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-white"
            title="Scroll Right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Horizontal Scroll Shelf */}
      <div
        ref={rowRef}
        className="flex space-x-4 overflow-x-auto scrollbar-none py-3 -my-3 scroll-smooth no-scrollbar"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((item, index) => (
          <MediaCard
            key={item.id}
            item={item}
            onSelect={onSelect}
            watchProgress={progressMap?.get(item.id)}
            navGroup={`row-${rowOrder}`}
            navIndex={index}
            navRow={rowOrder}
          />
        ))}
      </div>
    </section>
  );
};
