import React from 'react';
import { Play, Clock, Check } from 'lucide-react';
import type { WatchProgress, ChannelVideoItem } from '../types';
import { getTMDBImageUrl } from '../services/tmdb';

interface ContinueWatchingRowProps {
  title?: string;
  progressList: WatchProgress[];
  videoMap: Map<string, ChannelVideoItem>;
  onResume: (item: ChannelVideoItem, resumeTime: number) => void;
  rowOrder: number;
}

export const ContinueWatchingRow: React.FC<ContinueWatchingRowProps> = ({
  title,
  progressList,
  videoMap,
  onResume,
  rowOrder,
}) => {
  if (!progressList || progressList.length === 0) return null;

  return (
    <section className="relative px-6 md:px-10 py-5">
      <div className="flex items-center space-x-2.5 mb-4">
        <Clock className="w-5 h-5 text-white/70" />
        <h2 className="text-xl md:text-2xl font-semibold text-white tracking-tight">
          {title || 'Up Next • Continue Watching'}
        </h2>
      </div>

      <div className="flex space-x-5 overflow-x-auto scrollbar-none py-3 -my-3 scroll-smooth no-scrollbar">
        {progressList.map((entry, index) => {
          const videoItem = videoMap.get(entry.id);
          if (!videoItem) return null;

          const progressPercent = entry.duration > 0 ? (entry.currentTime / entry.duration) * 100 : 0;
          const isWatched = progressPercent >= 90;
          const timeLeftSec = Math.max(0, entry.duration - entry.currentTime);
          const timeLeftMin = Math.round(timeLeftSec / 60);

          const backdrop = getTMDBImageUrl(entry.backdropPath, 'w780') || getTMDBImageUrl(entry.posterPath, 'w500');

          return (
            <div
              key={entry.id}
              tabIndex={0}
              data-nav-group="continue-watching"
              data-nav-index={index}
              data-nav-row={rowOrder}
              onClick={() => onResume(videoItem, isWatched ? 0 : entry.currentTime)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onResume(videoItem, isWatched ? 0 : entry.currentTime);
                }
              }}
              className="group relative flex-none w-[260px] sm:w-[310px] aspect-[16/9] rounded-2xl overflow-hidden cursor-pointer bg-[#141416] border border-white/10 hover:border-white/30 transition-all duration-300 ease-out hover:scale-[1.04] active:scale-97 hover:z-20 focus:scale-[1.04] focus:z-20 focus:outline-none focus:ring-4 focus:ring-white focus:shadow-[0_0_25px_rgba(255,255,255,0.3)] shadow-lg"
            >
              {/* Backdrop image */}
              {backdrop ? (
                <img
                  src={backdrop}
                  alt={entry.title}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-tr from-zinc-800 to-black flex items-center justify-center">
                  <Play className="w-10 h-10 text-white/30" />
                </div>
              )}

              {/* Apple TV Overlay Gradient */}
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent p-4 flex flex-col justify-end">
                {/* Center Play Button on Hover */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-200">
                  <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-2xl shadow-black/80">
                    <Play className="w-5 h-5 fill-black ml-0.5" />
                  </div>
                </div>

                <div className="relative z-10 space-y-0.5">
                  <h4 className="font-semibold text-sm text-white line-clamp-1 tracking-tight">
                    {entry.title}
                  </h4>
                  <div className="flex items-center justify-between text-xs text-white/70 font-medium">
                    <span>{entry.episodeInfo || 'Feature Film'}</span>
                    {isWatched ? (
                      <span className="text-emerald-400 font-semibold flex items-center">
                        <Check className="w-3 h-3 mr-1 stroke-[2.5]" />
                        Watched
                      </span>
                    ) : (
                      <span>{timeLeftMin > 0 ? `${timeLeftMin}m left` : 'Resume'}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Progress Bar Track */}
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${isWatched ? 'bg-emerald-400' : 'bg-white'}`}
                  style={{ width: `${Math.min(100, Math.max(5, progressPercent))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
