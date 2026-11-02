import React, { useState, useEffect, useRef } from 'react';
import { Play, Plus, Check, Star, Info, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChannelVideoItem } from '../types';
import { getTMDBImageUrl } from '../services/tmdb';

interface HeroBannerCarouselProps {
  items: ChannelVideoItem[];
  onPlay: (item: ChannelVideoItem) => void;
  onOpenDetails: (item: ChannelVideoItem) => void;
  isBookmarked: (id: string) => boolean;
  onToggleBookmark: (item: ChannelVideoItem) => void;
}

export const HeroBannerCarousel: React.FC<HeroBannerCarouselProps> = ({
  items,
  onPlay,
  onOpenDetails,
  isBookmarked,
  onToggleBookmark,
}) => {
  const featured = items.slice(0, 6);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  // Auto-advance every 8 seconds
  useEffect(() => {
    if (featured.length <= 1) return;

    timerRef.current = window.setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % featured.length);
    }, 8000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [featured.length, currentIndex]);

  const handlePrev = () => {
    if (featured.length <= 1) return;
    setCurrentIndex((prev) => (prev - 1 + featured.length) % featured.length);
  };

  const handleNext = () => {
    if (featured.length <= 1) return;
    setCurrentIndex((prev) => (prev + 1) % featured.length);
  };

  if (!featured || featured.length === 0) {
    return (
      <div className="relative w-full h-[65vh] min-h-[480px] bg-black flex items-center justify-center border-b border-white/5">
        <div className="text-center max-w-md px-6 space-y-3">
          <h2 className="text-2xl font-semibold text-white tracking-tight">Your Cinema Canvas</h2>
          <p className="text-sm text-zinc-400">
            Select &ldquo;Channels&rdquo; in the top navigation to connect your Telegram media channels and start streaming.
          </p>
        </div>
      </div>
    );
  }

  const currentItem = featured[currentIndex] || featured[0];
  const title = currentItem.tmdb?.title || currentItem.parsed.cleanTitle;
  const overview =
    currentItem.tmdb?.overview ||
    'High-definition video ready for zero-server, instant client-side playback directly from Telegram MTProto.';
  const backdropUrl = getTMDBImageUrl(currentItem.tmdb?.backdropPath || null, 'original');
  const rating = currentItem.tmdb?.voteAverage;
  const year = currentItem.tmdb?.releaseDate
    ? new Date(currentItem.tmdb.releaseDate).getFullYear()
    : currentItem.parsed.year;
  const resolution = currentItem.parsed.resolution || '4K';
  const isSeries = currentItem.parsed.isSeries;
  const bookmarked = isBookmarked(currentItem.id);

  return (
    <div className="relative w-full h-[78vh] min-h-[560px] max-h-[860px] overflow-hidden select-none group/carousel bg-black">
      {/* Background Cinematic Artwork with Smooth Crossfade */}
      <div className="absolute inset-0">
        {backdropUrl ? (
          <img
            key={currentItem.id}
            src={backdropUrl}
            alt={title}
            className="w-full h-full object-cover object-top opacity-85 transition-opacity duration-1000 animate-scale-in"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-zinc-900 via-black to-black opacity-90" />
        )}
      </div>

      {/* Apple TV+ Atmospheric Gradient Blends */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/80 to-transparent w-full md:w-3/4" />

      {/* Manual Left / Right Chevron Controls */}
      {featured.length > 1 && (
        <>
          <button
            onClick={handlePrev}
            className="absolute left-8 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-black/40 hover:bg-black/70 backdrop-blur-2xl border border-white/15 text-white opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hover:scale-105 active:scale-95 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white"
            title="Previous"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={handleNext}
            className="absolute right-8 top-1/2 -translate-y-1/2 z-20 w-12 h-12 rounded-full bg-black/40 hover:bg-black/70 backdrop-blur-2xl border border-white/15 text-white opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hover:scale-105 active:scale-95 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white"
            title="Next"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}

      {/* Hero Content Section */}
      <div className="absolute bottom-16 left-6 md:left-14 right-6 md:right-14 z-10 max-w-2xl space-y-4">
        {/* Apple TV Badge Row */}
        <div className="flex items-center flex-wrap gap-2 text-xs">
          <span className="px-2.5 py-0.5 rounded-full bg-white/15 backdrop-blur-2xl border border-white/20 text-white font-semibold text-[11px] uppercase tracking-wider">
            {isSeries ? 'Series' : 'Feature Film'}
          </span>
          <span className="px-2 py-0.5 rounded border border-white/25 text-[10px] font-bold text-white/90 uppercase">
            {resolution}
          </span>
          <span className="px-2 py-0.5 rounded border border-white/25 text-[10px] font-bold text-white/90">
            HDR
          </span>
          <span className="px-2 py-0.5 rounded border border-white/25 text-[10px] font-bold text-white/90">
            Dolby Atmos
          </span>
          <span className="px-1.5 py-0.5 rounded border border-white/25 text-[10px] font-bold text-white/90">
            CC
          </span>
          {rating ? (
            <div className="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-white/10 backdrop-blur-md text-white/90 text-xs font-semibold border border-white/15">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span>{rating.toFixed(1)}</span>
            </div>
          ) : null}
          {year && <span className="text-white/60 text-xs font-medium ml-1">{year}</span>}
        </div>

        {/* Cinematic Title */}
        <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white tracking-[-0.03em] leading-tight line-clamp-2">
          {title}
        </h1>

        {/* Editorial Synopsis */}
        <p className="text-sm md:text-base text-white/80 line-clamp-3 leading-relaxed max-w-xl font-normal">
          {overview}
        </p>

        {/* Apple TV Action Pills */}
        <div className="flex items-center flex-wrap gap-3.5 pt-2">
          {/* Primary Solid White Button */}
          <button
            onClick={() => onPlay(currentItem)}
            className="flex items-center space-x-2.5 px-8 py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-[0_0_25px_rgba(255,255,255,0.3)] transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-white/40"
          >
            <Play className="w-4 h-4 fill-black ml-0.5" />
            <span>Play</span>
          </button>

          {/* Secondary Glass Pill Button */}
          <button
            onClick={() => onOpenDetails(currentItem)}
            className="flex items-center space-x-2 px-6 py-3.5 rounded-full bg-white/15 hover:bg-white/25 active:scale-95 backdrop-blur-2xl border border-white/15 text-white font-semibold text-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white"
          >
            <Info className="w-4 h-4" />
            <span>Details</span>
          </button>

          {/* Bookmark Circular Glass Button */}
          <button
            onClick={() => onToggleBookmark(currentItem)}
            className={`w-12 h-12 rounded-full border backdrop-blur-2xl flex items-center justify-center transition-all duration-200 active:scale-95 focus:outline-none focus:ring-2 focus:ring-white ${
              bookmarked
                ? 'bg-white text-black border-white shadow-md'
                : 'bg-white/10 hover:bg-white/20 border-white/15 text-white'
            }`}
            title={bookmarked ? 'Remove from My List' : 'Add to My List'}
          >
            {bookmarked ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Apple TV Carousel Horizontal Progress Indicators */}
      {featured.length > 1 && (
        <div className="absolute bottom-6 right-6 md:right-14 z-20 flex items-center space-x-2">
          {featured.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentIndex(idx)}
              className={`h-1 rounded-full transition-all duration-300 ${
                idx === currentIndex
                  ? 'w-8 bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]'
                  : 'w-2.5 bg-white/30 hover:bg-white/60'
              }`}
              title={`Slide ${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
