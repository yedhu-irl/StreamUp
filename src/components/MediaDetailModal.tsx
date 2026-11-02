import React, { useState, useEffect } from 'react';
import { 
  Play, 
  Plus, 
  Check, 
  RotateCcw, 
  Star, 
  ArrowLeft,
  Tv, 
  Copy,
  ExternalLink,
  Film
} from 'lucide-react';
import type { ChannelVideoItem, ChannelCategory, WatchProgress, TMDBCastMember } from '../types';
import { getTMDBImageUrl, fetchCastForMedia } from '../services/tmdb';
import { db } from '../services/db';
import { resolveCachedDocument } from '../services/telegram';
import { tgStreamEngine } from '../services/tgStreamEngine';

interface MediaDetailModalProps {
  item: ChannelVideoItem;
  allVideos?: ChannelVideoItem[];
  channels?: ChannelCategory[];
  onClose: () => void;
  onPlay: (item: ChannelVideoItem, resumeTime?: number) => void;
  onOpenSeries?: (item: ChannelVideoItem) => void;
  onSelectMedia?: (item: ChannelVideoItem) => void;
  isBookmarked: boolean;
  onToggleBookmark: (item: ChannelVideoItem) => void;
}

export const MediaDetailModal: React.FC<MediaDetailModalProps> = ({
  item,
  allVideos = [],
  channels = [],
  onClose,
  onPlay,
  onOpenSeries,
  onSelectMedia,
  isBookmarked,
  onToggleBookmark,
}) => {
  const [watchProgress, setWatchProgress] = useState<WatchProgress | null>(null);
  const [castMembers, setCastMembers] = useState<TMDBCastMember[]>(item.tmdb?.castMembers || []);
  const [copiedLink, setCopiedLink] = useState(false);

  // Load resume watch progress
  useEffect(() => {
    async function loadProgress() {
      const p = await db.watchProgress.get(item.id);
      if (p) {
        setWatchProgress(p);
      }
    }
    loadProgress();
  }, [item.id]);

  // Early Pre-Warming: preload container header and tail chunks before user clicks Play
  useEffect(() => {
    let active = true;
    const warm = async () => {
      try {
        const cached = await resolveCachedDocument(item.channelId, item.messageId);
        if (cached && cached.doc && active) {
          const fileName = item.fileName || item.parsed?.originalFileName || 'video.mp4';
          tgStreamEngine.warmFile(
            item.channelId,
            item.messageId,
            cached.doc,
            fileName,
            cached.mimeType || 'video/mp4'
          );
        }
      } catch (e) {
        // non-blocking pre-warm error
      }
    };
    warm();
    return () => {
      active = false;
    };
  }, [item.channelId, item.messageId, item.fileName]);

  // Load cast with profile pictures from TMDB if not already embedded
  useEffect(() => {
    if (item.tmdb?.castMembers && item.tmdb.castMembers.length > 0) {
      setCastMembers(item.tmdb.castMembers);
      return;
    }

    if (item.tmdb?.id) {
      fetchCastForMedia(item.tmdb.id, item.parsed.isSeries).then((members) => {
        if (members && members.length > 0) {
          setCastMembers(members);
        }
      });
    }
  }, [item.tmdb?.id, item.parsed.isSeries]);

  // Keyboard shortcut Esc for back
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Back') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const title = item.tmdb?.title || item.parsed.cleanTitle;
  const overview =
    item.tmdb?.overview ||
    'High-definition video ready for zero-server, instant client-side playback directly from Telegram MTProto.';
  const backdropUrl = getTMDBImageUrl(item.tmdb?.backdropPath || null, 'original');
  const posterUrl = getTMDBImageUrl(item.tmdb?.posterPath || null, 'w500');
  const rating = item.tmdb?.voteAverage;
  const year = item.tmdb?.releaseDate ? new Date(item.tmdb.releaseDate).getFullYear() : item.parsed.year;
  const resolution = item.parsed.resolution || '4K';
  const codec = item.parsed.codec;
  const isSeries = item.parsed.isSeries || channels.find((c) => c.id === item.channelId)?.contentType === 'series';

  const hasResume = watchProgress && watchProgress.currentTime > 10;
  const progressPercent = hasResume && watchProgress.duration > 0
    ? Math.round((watchProgress.currentTime / watchProgress.duration) * 100)
    : 0;
  const timeLeftMin = hasResume
    ? Math.max(1, Math.round((watchProgress.duration - watchProgress.currentTime) / 60))
    : 0;

  // Suggested movies from the same Telegram channel
  const channelName = channels.find((c) => c.id === item.channelId)?.title || 'This Channel';
  const suggestedMovies = allVideos
    .filter((v) => v.channelId === item.channelId && v.id !== item.id)
    .slice(0, 14);

  const streamUrl = typeof window !== 'undefined' 
    ? `${window.location.origin}/stream/${encodeURIComponent(item.channelId)}/${item.messageId}`
    : `/stream/${encodeURIComponent(item.channelId)}/${item.messageId}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(streamUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (e) {
      // ignore
    }
  };

  const handleOpenVLC = () => {
    window.location.href = `vlc://${streamUrl}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black text-white overflow-y-auto animate-fade-in select-none no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      {/* Top Pinned Glass Navigation Bar */}
      <div className="sticky top-0 left-0 right-0 z-50 h-20 px-6 md:px-12 flex items-center justify-between backdrop-blur-3xl bg-black/75 border-b border-white/10 transition-all">
        <button
          onClick={onClose}
          className="flex items-center space-x-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white font-medium text-xs backdrop-blur-2xl transition-all focus:outline-none focus:ring-2 focus:ring-white"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <span className="font-semibold text-sm text-white/80 truncate max-w-md hidden sm:inline">
          {title}
        </span>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleCopyLink}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-xs text-white/90 active:scale-95 transition-all"
            title="Copy Direct Stream URL"
          >
            {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="hidden md:inline">{copiedLink ? 'Copied' : 'Stream Link'}</span>
          </button>

          <button
            onClick={handleOpenVLC}
            className="flex items-center space-x-1 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-xs text-white/90 active:scale-95 transition-all"
            title="Open in VLC"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden md:inline">VLC</span>
          </button>
        </div>
      </div>

      {/* Cinematic Full-Bleed 72vh Hero Banner */}
      <div className="relative h-[65vh] md:h-[72vh] w-full overflow-hidden bg-black flex items-end">
        {backdropUrl ? (
          <img
            src={backdropUrl}
            alt={title}
            className="absolute inset-0 w-full h-full object-cover object-top opacity-85 scale-[1.01]"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-800 via-black to-black" />
        )}

        {/* Multi-stop Apple TV Gradients */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/80 to-transparent w-full md:w-3/4" />

        {/* Hero Title & Actions Overlay */}
        <div className="relative z-10 px-6 md:px-16 pb-12 max-w-4xl space-y-5">
          {/* Badges */}
          <div className="flex items-center flex-wrap gap-2 text-xs font-semibold">
            <span className="px-3 py-0.5 rounded-full bg-white/15 backdrop-blur-md text-white border border-white/20 text-[11px] uppercase tracking-wider">
              {isSeries ? 'TV Series' : 'Feature Film'}
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
            {year && <span className="text-white/70 ml-1">{year}</span>}
            {rating ? (
              <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white border border-white/15">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span>{rating.toFixed(1)}</span>
              </div>
            ) : null}
            {codec && <span className="text-white/50 uppercase text-[10px]">{codec}</span>}
          </div>

          {/* Title */}
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white drop-shadow-md">
            {title}
          </h1>

          {/* Primary Action Buttons */}
          <div className="flex items-center flex-wrap gap-4 pt-2">
            {hasResume ? (
              <button
                onClick={() => onPlay(item, watchProgress?.currentTime)}
                className="flex items-center space-x-3 px-8 py-4 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-[0_0_30px_rgba(255,255,255,0.3)] transition-all focus:outline-none focus:ring-4 focus:ring-white/40"
              >
                <Play className="w-5 h-5 fill-black ml-0.5" />
                <span>Resume ({progressPercent}%)</span>
              </button>
            ) : (
              <button
                onClick={() => onPlay(item, 0)}
                className="flex items-center space-x-3 px-8 py-4 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-[0_0_30px_rgba(255,255,255,0.3)] transition-all focus:outline-none focus:ring-4 focus:ring-white/40"
              >
                <Play className="w-5 h-5 fill-black ml-0.5" />
                <span>{isSeries ? 'Play Episode' : 'Play Movie'}</span>
              </button>
            )}

            {/* Restart from Beginning */}
            {hasResume && (
              <button
                onClick={() => onPlay(item, 0)}
                className="flex items-center space-x-2 px-6 py-4 rounded-full backdrop-blur-2xl bg-white/15 hover:bg-white/25 active:scale-95 border border-white/20 text-white font-semibold text-sm transition-all focus:outline-none focus:ring-2 focus:ring-white"
              >
                <RotateCcw className="w-4 h-4" />
                <span>From Beginning</span>
              </button>
            )}

            {/* Watchlist Toggle */}
            <button
              onClick={() => onToggleBookmark(item)}
              className="flex items-center space-x-2 px-6 py-4 rounded-full backdrop-blur-2xl bg-white/15 hover:bg-white/25 active:scale-95 border border-white/20 text-white font-semibold text-sm transition-all focus:outline-none focus:ring-2 focus:ring-white"
            >
              {isBookmarked ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>Added to My List</span>
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  <span>Add to My List</span>
                </>
              )}
            </button>

            {/* TV Series Season Navigator */}
            {isSeries && onOpenSeries && (
              <button
                onClick={() => onOpenSeries(item)}
                className="flex items-center space-x-2 px-6 py-4 rounded-full backdrop-blur-2xl bg-white/15 hover:bg-white/25 active:scale-95 border border-white/20 text-white font-semibold text-sm transition-all focus:outline-none focus:ring-2 focus:ring-white"
              >
                <Tv className="w-4 h-4" />
                <span>Browse Episodes</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Body */}
      <div className="px-6 md:px-16 py-10 space-y-12 max-w-7xl mx-auto">
        {/* Responsive Side-by-Side: Poster on Left, Details on Right (as in screenshot) */}
        <div className="flex flex-col md:flex-row items-start gap-8 lg:gap-12">
          {/* Vertical Movie Poster Card on the Left */}
          <div className="flex-none w-[180px] sm:w-[220px] lg:w-[260px] aspect-[2/3] rounded-3xl overflow-hidden bg-[#141416] border border-white/15 shadow-2xl">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt={title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-zinc-900 flex flex-col items-center justify-center text-white/40 p-4 text-center">
                <Film className="w-10 h-10 mb-2" />
                <span className="text-xs font-semibold">{title}</span>
              </div>
            )}
          </div>

          {/* Details (Resume progress, Synopsis, Cast & Crew) on Right */}
          <div className="flex-1 min-w-0 space-y-8">
            {/* Watch Progress Indicator */}
            {hasResume && (
              <div className="p-5 rounded-3xl bg-white/5 border border-white/10 space-y-2 max-w-lg">
                <div className="flex items-center justify-between text-xs font-semibold text-zinc-300">
                  <span>Continue Watching ({progressPercent}%)</span>
                  <span>{timeLeftMin}m remaining</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-all"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Synopsis Overview */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">
                Synopsis
              </h3>
              <p className="text-base md:text-lg text-white/80 leading-relaxed font-normal">
                {overview}
              </p>
            </div>

            {/* Circular Cast Profiles */}
            {castMembers.length > 0 && (
              <div className="space-y-4 pt-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">
                  Cast &amp; Crew
                </h3>
                <div className="flex items-start space-x-6 overflow-x-auto pb-4 no-scrollbar">
                  {castMembers.map((member, i) => {
                    const profileImg = getTMDBImageUrl(member.profilePath, 'w300');
                    return (
                      <div key={i} className="flex flex-col items-center flex-none w-24 group">
                        <div className="w-20 h-20 rounded-full overflow-hidden bg-white/10 border-2 border-white/15 group-hover:border-white shadow-xl group-hover:scale-105 transition-all duration-200">
                          {profileImg ? (
                            <img
                              src={profileImg}
                              alt={member.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-zinc-800 text-white/60 font-bold text-sm">
                              {member.name.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <span className="text-xs font-semibold text-white text-center mt-2.5 truncate w-full group-hover:text-white">
                          {member.name}
                        </span>
                        {member.character && (
                          <span className="text-[10px] text-white/50 text-center truncate w-full mt-0.5">
                            {member.character}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Suggested Movies from Same Channel */}
        {suggestedMovies.length > 0 && (
          <div className="space-y-4 pt-4 border-t border-white/10">
            <div className="flex items-center space-x-2">
              <Film className="w-4 h-4 text-white/60" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-white/70">
                More from {channelName}
              </h3>
            </div>

            <div className="flex items-start space-x-5 overflow-x-auto pb-4 no-scrollbar">
              {suggestedMovies.map((sug) => {
                const poster = getTMDBImageUrl(sug.tmdb?.posterPath || null, 'w300');
                const sugTitle = sug.tmdb?.title || sug.parsed.cleanTitle;

                return (
                  <div
                    key={sug.id}
                    onClick={() => {
                      if (onSelectMedia) onSelectMedia(sug);
                    }}
                    className="flex-none w-40 cursor-pointer group space-y-2"
                  >
                    <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-white/5 border border-white/15 group-hover:border-white group-hover:scale-105 transition-all duration-200 shadow-xl">
                      {poster ? (
                        <img
                          src={poster}
                          alt={sugTitle}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-3 text-center text-xs font-semibold text-white/60 bg-gradient-to-br from-zinc-800 to-black">
                          {sugTitle}
                        </div>
                      )}

                      {/* Resolution badge */}
                      <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-md text-[9px] font-bold text-white uppercase border border-white/10">
                        {sug.parsed.resolution || 'HD'}
                      </div>
                    </div>

                    <h4 className="text-xs font-medium text-white truncate group-hover:text-white">
                      {sugTitle}
                    </h4>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Technical File Metadata Bar */}
        <div className="pt-8 border-t border-white/10 flex items-center flex-wrap gap-8 text-xs text-white/60">
          <div>
            <span className="text-white/40 block">File Name</span>
            <span className="font-mono text-white/80 truncate max-w-md block mt-0.5">{item.fileName}</span>
          </div>
          <div>
            <span className="text-white/40 block">File Size</span>
            <span className="text-white/80 block mt-0.5">{(item.fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB</span>
          </div>
          <div>
            <span className="text-white/40 block">Container Format</span>
            <span className="text-white/80 block mt-0.5">{item.mimeType || 'video/x-matroska'}</span>
          </div>
          <div>
            <span className="text-white/40 block">Source Channel</span>
            <span className="text-white/80 block mt-0.5">{channelName}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
