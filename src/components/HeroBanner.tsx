import React from 'react';
import { Play, Plus, Check, Star, Info } from 'lucide-react';
import type { ChannelVideoItem } from '../types';
import { getTMDBImageUrl } from '../services/tmdb';

interface HeroBannerProps {
  item: ChannelVideoItem | null;
  onPlay: (item: ChannelVideoItem) => void;
  onMoreInfo?: (item: ChannelVideoItem) => void;
  isBookmarked: boolean;
  onToggleBookmark: (item: ChannelVideoItem) => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({
  item,
  onPlay,
  onMoreInfo,
  isBookmarked,
  onToggleBookmark,
}) => {
  if (!item) {
    return (
      <div className="relative w-full h-[65vh] min-h-[480px] bg-obsidian-900 flex items-center justify-center border-b border-white/5">
        <div className="text-center max-w-md px-6">
          <h2 className="text-2xl font-bold font-display text-zinc-300">No media channels connected yet</h2>
          <p className="text-sm text-zinc-500 mt-2">
            Click &ldquo;Add Category&rdquo; in the header to select your Telegram channels and start streaming.
          </p>
        </div>
      </div>
    );
  }

  const title = item.tmdb?.title || item.parsed.cleanTitle;
  const overview = item.tmdb?.overview || 'High-definition video ready for instant client-side playback directly from Telegram MTProto.';
  const backdropUrl = getTMDBImageUrl(item.tmdb?.backdropPath || null, 'original');
  const rating = item.tmdb?.voteAverage;
  const year = item.tmdb?.releaseDate ? new Date(item.tmdb.releaseDate).getFullYear() : item.parsed.year;
  const resolution = item.parsed.resolution || 'HD';
  const isSeries = item.parsed.isSeries;

  return (
    <div className="relative w-full h-[72vh] min-h-[520px] max-h-[780px] overflow-hidden select-none">
      {/* Background Fanart Backdrop */}
      {backdropUrl ? (
        <img
          src={backdropUrl}
          alt={title}
          className="absolute inset-0 w-full h-full object-cover object-top opacity-70 transition-transform duration-1000 scale-100 hover:scale-105"
        />
      ) : (
        <div className="absolute inset-0 w-full h-full bg-gradient-to-br from-obsidian-850 via-obsidian-900 to-obsidian-950 opacity-90" />
      )}

      {/* Cinematic Multi-Stop Gradient Masks (Bottom & Left fade to deep Obsidian) */}
      <div className="absolute inset-0 bg-gradient-to-t from-obsidian-950 via-obsidian-950/70 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-obsidian-950 via-obsidian-950/80 to-transparent w-full md:w-3/4" />

      {/* Hero Content */}
      <div className="relative z-10 h-full max-w-7xl mx-auto px-8 flex flex-col justify-end pb-16">
        <div className="max-w-2xl space-y-4 animate-fade-in">
          {/* Metadata Badges */}
          <div className="flex items-center flex-wrap gap-2.5">
            {isSeries && (
              <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider bg-white/10 text-white border border-white/20">
                Series
              </span>
            )}
            {resolution && (
              <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40">
                {resolution}
              </span>
            )}
            {year && (
              <span className="text-xs font-semibold text-zinc-300">
                {year}
              </span>
            )}
            {rating ? (
              <div className="flex items-center space-x-1 px-2 py-0.5 rounded-md bg-black/50 border border-white/10 text-xs font-bold text-amber-400">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span>{rating.toFixed(1)}</span>
              </div>
            ) : null}
            {item.parsed.quality && (
              <span className="text-xs font-medium text-zinc-400">
                {item.parsed.quality}
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="text-4xl md:text-6xl font-extrabold font-display tracking-tight text-white drop-shadow-md leading-tight">
            {title}
          </h1>

          {/* Overview */}
          <p className="text-sm md:text-base text-zinc-300/90 line-clamp-3 leading-relaxed drop-shadow">
            {overview}
          </p>

          {/* Action CTAs */}
          <div className="flex items-center space-x-4 pt-3">
            {/* Play Button */}
            <button
              onClick={() => onPlay(item)}
              data-nav-group="hero"
              data-nav-index="0"
              data-nav-row="1"
              className="flex items-center space-x-2.5 px-7 py-3.5 rounded-xl bg-white hover:bg-zinc-200 text-black font-semibold text-base shadow-xl transition-all hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 focus:ring-white/90"
            >
              <Play className="w-5 h-5 fill-black text-black" />
              <span>Watch Now</span>
            </button>

            {/* My List Bookmark Toggle */}
            <button
              onClick={() => onToggleBookmark(item)}
              data-nav-group="hero"
              data-nav-index="1"
              data-nav-row="1"
              className="flex items-center space-x-2 px-5 py-3.5 rounded-xl backdrop-blur-xl bg-white/10 hover:bg-white/20 border border-white/15 text-white font-medium text-sm transition-all hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 focus:ring-white/90"
            >
              {isBookmarked ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>In My List</span>
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  <span>My List</span>
                </>
              )}
            </button>

            {/* More Info */}
            {onMoreInfo && (
              <button
                onClick={() => onMoreInfo(item)}
                data-nav-group="hero"
                data-nav-index="2"
                data-nav-row="1"
                className="p-3.5 rounded-xl backdrop-blur-xl bg-white/10 hover:bg-white/20 border border-white/15 text-white transition-all hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 focus:ring-white/90"
                title="Details & Episodes"
              >
                <Info className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

