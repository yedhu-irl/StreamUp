import React from 'react';
import { Play, Star, Film, Check } from 'lucide-react';
import type { ChannelVideoItem, WatchProgress } from '../types';
import { getTMDBImageUrl } from '../services/tmdb';

interface MediaCardProps {
  item: ChannelVideoItem;
  onSelect: (item: ChannelVideoItem) => void;
  watchProgress?: WatchProgress;
  className?: string;
  navGroup?: string;
  navIndex?: number;
  navRow?: number;
}

export const MediaCard: React.FC<MediaCardProps> = ({
  item,
  onSelect,
  watchProgress,
  className,
  navGroup,
  navIndex,
  navRow,
}) => {
  const title = item.tmdb?.title || item.parsed.cleanTitle;
  const posterUrl = getTMDBImageUrl(item.tmdb?.posterPath || null, 'w500');
  const rating = item.tmdb?.voteAverage;
  const year = item.tmdb?.releaseDate ? new Date(item.tmdb.releaseDate).getFullYear() : item.parsed.year;
  const resolution = item.parsed.resolution;
  const isSeries = item.parsed.isSeries;

  const isWatched = Boolean(
    watchProgress &&
    watchProgress.duration > 0 &&
    (watchProgress.currentTime / watchProgress.duration) >= 0.90
  );
  const inProgressPercent =
    watchProgress && watchProgress.duration > 0 && !isWatched && watchProgress.currentTime > 15
      ? Math.min(100, Math.max(5, (watchProgress.currentTime / watchProgress.duration) * 100))
      : 0;

  const widthClass = className || 'flex-none w-[160px] sm:w-[190px] md:w-[210px]';

  return (
    <div
      tabIndex={0}
      data-nav-group={navGroup}
      data-nav-index={navIndex}
      data-nav-row={navRow}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelect(item);
        }
      }}
      className={`group relative aspect-[2/3] rounded-2xl overflow-hidden cursor-pointer bg-[#121214] border border-white/10 hover:border-white/25 transition-all duration-300 ease-out hover:scale-[1.04] active:scale-97 hover:z-20 focus:scale-[1.04] focus:z-20 focus:outline-none focus:ring-4 focus:ring-white focus:shadow-[0_0_25px_rgba(255,255,255,0.3)] shadow-lg ${widthClass}`}
    >
      {/* Poster Image */}
      {posterUrl ? (
        <img
          src={posterUrl}
          alt={title}
          loading="lazy"
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
      ) : (
        <div className="w-full h-full p-4 flex flex-col justify-between bg-gradient-to-b from-zinc-800 to-black text-zinc-300">
          <div className="flex items-center justify-between">
            <Film className="w-6 h-6 text-white/50" />
            {resolution && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-white/20 text-white/80">
                {resolution}
              </span>
            )}
          </div>
          <div>
            <h4 className="font-semibold text-sm text-white line-clamp-3 tracking-tight">
              {title}
            </h4>
            {year && <span className="text-xs text-white/50 mt-1 block">{year}</span>}
          </div>
        </div>
      )}

      {/* Top Badges (Series, Watched, Rating) */}
      <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none gap-1">
        <div className="flex items-center space-x-1">
          {isSeries && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-black/60 backdrop-blur-md text-white/90 border border-white/15">
              Series
            </span>
          )}
          {isWatched && (
            <span className="flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/80 backdrop-blur-md text-white border border-emerald-400/30">
              <Check className="w-2.5 h-2.5 stroke-[2.5]" />
              <span>Watched</span>
            </span>
          )}
        </div>

        {rating ? (
          <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] font-bold text-white border border-white/15">
            <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
            <span>{rating.toFixed(1)}</span>
          </div>
        ) : null}
      </div>

      {/* In-Progress Bottom Progress Bar */}
      {inProgressPercent > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20 z-10">
          <div
            className="h-full bg-white rounded-full transition-all duration-300"
            style={{ width: `${inProgressPercent}%` }}
          />
        </div>
      )}

      {/* Apple TV Ambient Bottom Hover Layer */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-300 p-4 flex flex-col justify-end">
        <div className="transform translate-y-2 group-hover:translate-y-0 group-focus:translate-y-0 transition-transform duration-300 space-y-1.5">
          <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-lg shadow-black/80 mb-2">
            <Play className="w-4 h-4 fill-black ml-0.5" />
          </div>

          <h3 className="font-semibold text-sm text-white line-clamp-2 leading-snug tracking-tight">
            {title}
          </h3>

          <div className="flex items-center space-x-2 text-[11px] text-white/70 font-medium">
            {year && <span>{year}</span>}
            {resolution && (
              <>
                <span>&bull;</span>
                <span>{resolution}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
