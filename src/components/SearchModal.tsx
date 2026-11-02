import React, { useState, useMemo, useEffect } from 'react';
import { Search, X, Film, ArrowLeft, Tv, Sparkles } from 'lucide-react';
import type { ChannelVideoItem, ChannelCategory, WatchProgress } from '../types';
import { MediaCard } from './MediaCard';

interface SearchModalProps {
  videos: ChannelVideoItem[];
  channels?: ChannelCategory[];
  collapseVideos?: (v: ChannelVideoItem[]) => ChannelVideoItem[];
  progressMap?: Map<string, WatchProgress>;
  onSelect: (item: ChannelVideoItem) => void;
  onClose: () => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  videos,
  channels = [],
  collapseVideos,
  progressMap,
  onSelect,
  onClose,
}) => {
  const [query, setQuery] = useState<string>('');
  const [filterType, setFilterType] = useState<'all' | 'movies' | 'series'>('all');

  // Esc key for back
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Back') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Helper to deduplicate series into single show cards
  const collapseList = useMemo(() => {
    return (raw: ChannelVideoItem[]) => {
      if (collapseVideos) {
        return collapseVideos(raw);
      }
      const deduped: ChannelVideoItem[] = [];
      const seen = new Set<string>();
      const chMap = new Map(channels.map((c) => [c.id, c]));

      for (const item of raw) {
        const isSeries = item.parsed.isSeries || chMap.get(item.channelId)?.contentType === 'series';
        if (isSeries) {
          const key = (item.tmdb?.title || item.parsed.cleanTitle).toLowerCase().trim();
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push({
              ...item,
              id: `series_show_${encodeURIComponent(key)}`,
              parsed: { ...item.parsed, isSeries: true },
            });
          }
        } else {
          deduped.push(item);
        }
      }
      return deduped;
    };
  }, [collapseVideos, channels]);

  const filtered = useMemo(() => {
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    // 1. Initial Type Filter
    let candidateVideos = videos;
    if (filterType === 'movies') {
      candidateVideos = videos.filter(
        (v) => !v.parsed.isSeries && channelMap.get(v.channelId)?.contentType !== 'series'
      );
    } else if (filterType === 'series') {
      candidateVideos = videos.filter(
        (v) => v.parsed.isSeries || channelMap.get(v.channelId)?.contentType === 'series'
      );
    }

    // 2. Query Search
    const q = query.toLowerCase().trim();
    if (!q) {
      // Empty query: collapse all candidates so every show appears exactly ONCE
      return collapseList(candidateVideos);
    }

    const rawMatches = candidateVideos.filter((v) => {
      const titleMatch = (v.tmdb?.title || v.parsed.cleanTitle).toLowerCase().includes(q);
      const castMatch = v.tmdb?.cast?.some((c) => c.toLowerCase().includes(q));
      const genreMatch = v.tmdb?.genres?.some((g) => g.toLowerCase().includes(q));
      const fileMatch = v.fileName.toLowerCase().includes(q);
      const resMatch = v.parsed.resolution?.toLowerCase().includes(q);
      const yearMatch = v.parsed.year?.toString().includes(q);

      return titleMatch || castMatch || genreMatch || fileMatch || resMatch || yearMatch;
    });

    // Collapse matches so matching episodes don't duplicate the show card
    return collapseList(rawMatches);
  }, [videos, channels, query, filterType, collapseList]);

  return (
    <div className="fixed inset-0 z-50 bg-black text-white overflow-y-auto animate-fade-in select-none no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      {/* Top Pinned Glass Header */}
      <div className="sticky top-0 left-0 right-0 z-50 h-20 px-6 md:px-12 flex items-center justify-between backdrop-blur-3xl bg-black/75 border-b border-white/10 transition-all">
        <button
          onClick={onClose}
          className="flex items-center space-x-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white font-medium text-xs backdrop-blur-2xl transition-all focus:outline-none focus:ring-2 focus:ring-white"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <span className="font-semibold text-sm text-white/80 tracking-tight">
          Search Library
        </span>

        <div className="w-16" />
      </div>

      <div className="max-w-7xl mx-auto px-6 md:px-12 py-8 space-y-8">
        {/* Apple TV Minimalist Search Capsule */}
        <div className="relative flex items-center max-w-2xl mx-auto">
          <Search className="absolute left-6 w-5 h-5 text-white/40 pointer-events-none" />
          <input
            type="text"
            autoFocus
            placeholder="Search movies, TV shows, actors, resolutions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-15 pr-14 py-4 rounded-full bg-[#141416]/90 border border-white/15 focus:border-white text-base text-white placeholder-white/40 focus:outline-none transition-all shadow-2xl focus:ring-4 focus:ring-white/10"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-5 w-8 h-8 rounded-full hover:bg-white/10 text-white/60 hover:text-white flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Filter Pills Capsule */}
        <div className="flex items-center justify-center flex-wrap gap-2 pt-1">
          <div className="flex items-center space-x-1 bg-white/10 p-1 rounded-full border border-white/10">
            {(['all', 'movies', 'series'] as const).map((type) => {
              const isActive = filterType === type;
              return (
                <button
                  key={type}
                  onClick={() => setFilterType(type)}
                  className={`px-5 py-1.5 rounded-full text-xs font-semibold tracking-tight transition-all active:scale-95 ${
                    isActive
                      ? 'bg-white text-black shadow-md'
                      : 'text-white/70 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {type === 'all' ? 'All Titles' : type === 'movies' ? 'Movies' : 'TV Shows'}
                </button>
              );
            })}
          </div>

          <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/50 font-medium">
            {filtered.length} {filtered.length === 1 ? 'title' : 'titles'}
          </span>
        </div>

        {/* Spacious, Non-Overlapping Responsive Grid */}
        <div className="pt-2">
          {filtered.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5 md:gap-6">
              {filtered.map((item, index) => (
                <div key={item.id} className="w-full">
                  <MediaCard
                    item={item}
                    className="w-full"
                    onSelect={(selected) => {
                      onSelect(selected);
                      onClose();
                    }}
                    watchProgress={progressMap?.get(item.id)}
                    navGroup="search-results"
                    navIndex={index}
                    navRow={0}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-24 space-y-4 max-w-md mx-auto">
              <div className="w-16 h-16 rounded-3xl bg-white/10 border border-white/15 flex items-center justify-center mx-auto text-white/40 shadow-xl">
                <Search className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  {query ? `No titles found for "${query}"` : 'No titles available'}
                </h3>
                <p className="text-xs text-white/50 leading-relaxed">
                  {query
                    ? 'Check your spelling or try searching for a different movie, TV show, or actor.'
                    : 'Add broadcast channels in Profile to populate your streaming library.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
