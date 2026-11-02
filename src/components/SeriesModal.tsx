import React, { useState, useEffect } from 'react';
import { 
  Play, 
  Star, 
  Calendar, 
  ArrowLeft, 
  Clock, 
  Check, 
  Film, 
  Tv,
  RotateCcw,
  Sparkles
} from 'lucide-react';
import type { 
  SeriesGroup, 
  ChannelVideoItem, 
  TMDBMediaMetadata, 
  TMDBCastMember, 
  WatchProgress 
} from '../types';
import { 
  getTMDBImageUrl, 
  fetchTMDBSeasonEpisodes, 
  fetchCastForMedia, 
  fetchTMDBMetadata,
  type TMDBEpisodeDetail 
} from '../services/tmdb';
import { db } from '../services/db';
import { resolveCachedDocument } from '../services/telegram';
import { tgStreamEngine } from '../services/tgStreamEngine';

interface SeriesModalProps {
  series: SeriesGroup;
  onClose: () => void;
  onPlayEpisode: (item: ChannelVideoItem) => void;
}

export const SeriesModal: React.FC<SeriesModalProps> = ({
  series,
  onClose,
  onPlayEpisode,
}) => {
  const seasons = Object.keys(series.seasons)
    .map(Number)
    .sort((a, b) => a - b);

  const [activeSeason, setActiveSeason] = useState<number>(seasons[0] || 1);
  const [tmdbMeta, setTmdbMeta] = useState<TMDBMediaMetadata | null>(series.tmdb);
  const [seasonEpisodesMap, setSeasonEpisodesMap] = useState<Record<number, TMDBEpisodeDetail>>({});
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState<boolean>(false);
  const [castMembers, setCastMembers] = useState<TMDBCastMember[]>(series.tmdb?.castMembers || []);
  const [progressMap, setProgressMap] = useState<Map<string, WatchProgress>>(new Map());

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

  // Load Watch Progress for all episodes
  useEffect(() => {
    async function loadProgress() {
      try {
        const list = await db.watchProgress.toArray();
        const map = new Map<string, WatchProgress>();
        list.forEach((p) => map.set(p.id, p));
        setProgressMap(map);
      } catch (e) {
        // ignore
      }
    }
    loadProgress();
  }, []);

  // Ensure TMDB show metadata is present
  useEffect(() => {
    if (!tmdbMeta?.id && series.showTitle) {
      fetchTMDBMetadata(series.showTitle, undefined, true).then((meta) => {
        if (meta) setTmdbMeta(meta);
      });
    }
  }, [series.showTitle, tmdbMeta?.id]);

  // Load Cast Members if not already available
  useEffect(() => {
    if (castMembers.length === 0 && tmdbMeta?.id) {
      fetchCastForMedia(tmdbMeta.id, true).then((cast) => {
        if (cast && cast.length > 0) {
          setCastMembers(cast);
        }
      });
    }
  }, [tmdbMeta?.id, castMembers.length]);

  // Fetch Season Episode Details from TMDB whenever activeSeason or show changes
  useEffect(() => {
    if (tmdbMeta?.id) {
      setIsLoadingEpisodes(true);
      fetchTMDBSeasonEpisodes(tmdbMeta.id, activeSeason)
        .then((epMap) => {
          setSeasonEpisodesMap(epMap);
        })
        .finally(() => {
          setIsLoadingEpisodes(false);
        });
    }
  }, [tmdbMeta?.id, activeSeason]);

  // Pre-warm first episode of the active season
  useEffect(() => {
    const eps = series.seasons[activeSeason] || [];
    const firstEp = eps[0]?.videoItem;
    if (!firstEp) return;

    let active = true;
    const warm = async () => {
      try {
        const cached = await resolveCachedDocument(firstEp.channelId, firstEp.messageId);
        if (cached && cached.doc && active) {
          const fileName = firstEp.fileName || firstEp.parsed?.originalFileName || 'video.mp4';
          tgStreamEngine.warmFile(
            firstEp.channelId,
            firstEp.messageId,
            cached.doc,
            fileName,
            cached.mimeType || 'video/mp4'
          );
        }
      } catch (e) {
        // non-blocking
      }
    };
    warm();
    return () => {
      active = false;
    };
  }, [series, activeSeason]);

  const episodes = series.seasons[activeSeason] || [];
  const backdropUrl = getTMDBImageUrl(tmdbMeta?.backdropPath || series.tmdb?.backdropPath || null, 'original');
  const posterUrl = getTMDBImageUrl(tmdbMeta?.posterPath || series.tmdb?.posterPath || null, 'w500');
  const rating = tmdbMeta?.voteAverage || series.tmdb?.voteAverage;
  const year = tmdbMeta?.releaseDate
    ? new Date(tmdbMeta.releaseDate).getFullYear()
    : series.tmdb?.releaseDate
    ? new Date(series.tmdb.releaseDate).getFullYear()
    : undefined;
  const overview = tmdbMeta?.overview || series.tmdb?.overview || '';
  const genres = tmdbMeta?.genres || series.tmdb?.genres || [];

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
          {series.showTitle}
        </span>

        <div className="w-16" />
      </div>

      {/* Cinematic Hero Header with Full-Bleed Backdrop */}
      <div className="relative min-h-[50vh] md:min-h-[58vh] w-full overflow-hidden bg-black flex items-end">
        {backdropUrl ? (
          <img
            src={backdropUrl}
            alt={series.showTitle}
            className="absolute inset-0 w-full h-full object-cover object-top opacity-80 scale-[1.01]"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-r from-zinc-900 to-black" />
        )}

        {/* Multi-stop Apple TV Gradients */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/85 to-transparent w-full md:w-3/4" />

        {/* Details in Hero */}
        <div className="relative z-10 px-6 md:px-16 pb-10 space-y-4 max-w-4xl">
          <div className="flex items-center flex-wrap gap-2 text-xs font-semibold">
            <span className="px-3 py-0.5 rounded-full bg-white/15 backdrop-blur-md text-white border border-white/20 uppercase tracking-wider text-[11px]">
              TV Series
            </span>

            {year && (
              <span className="flex items-center text-white/70">
                <Calendar className="w-3.5 h-3.5 mr-1" />
                {year}
              </span>
            )}

            {rating ? (
              <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white border border-white/15">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span>{rating.toFixed(1)}</span>
              </div>
            ) : null}

            <span className="text-white/60">
              {seasons.length} {seasons.length === 1 ? 'Season' : 'Seasons'} &bull; {series.totalEpisodes} Episodes
            </span>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white tracking-tight drop-shadow-md">
            {series.showTitle}
          </h1>

          {/* Genres Pills */}
          {genres.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 pt-1">
              {genres.slice(0, 5).map((genre, i) => (
                <span
                  key={i}
                  className="px-2.5 py-0.5 rounded-full bg-white/10 text-white/80 border border-white/10 text-[11px] font-medium"
                >
                  {genre}
                </span>
              ))}
            </div>
          )}

          {/* Show Overview / Synopsis */}
          {overview && (
            <p className="text-sm md:text-base text-white/70 max-w-3xl line-clamp-3 leading-relaxed font-normal">
              {overview}
            </p>
          )}
        </div>
      </div>

      {/* Series Details & Cast with Left Poster Card (Apple TV / Screenshot Spec) */}
      <div className="px-6 md:px-16 pt-8 pb-6 border-b border-white/10 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row items-start gap-8 lg:gap-12">
          {/* Vertical Series Poster Card on Left */}
          <div className="flex-none mx-auto md:mx-0 w-[160px] sm:w-[190px] lg:w-[220px] aspect-[2/3] rounded-3xl overflow-hidden bg-[#141416] border border-white/15 shadow-2xl">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt={series.showTitle}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-zinc-900 flex flex-col items-center justify-center text-white/40 p-4 text-center">
                <Tv className="w-10 h-10 mb-2 text-white/30" />
                <span className="text-xs font-semibold">{series.showTitle}</span>
              </div>
            )}
          </div>

          {/* Right Column: Cast Carousel & Extra Series Info */}
          <div className="flex-1 min-w-0 space-y-4 w-full">
            {castMembers.length > 0 ? (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 mb-3">
                  Series Cast
                </h3>
                <div className="flex items-start space-x-6 overflow-x-auto pb-4 no-scrollbar">
                  {castMembers.slice(0, 12).map((member, i) => {
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
            ) : (
              overview && (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">
                    Series Synopsis
                  </h3>
                  <p className="text-sm text-white/70 leading-relaxed max-w-2xl font-normal">
                    {overview}
                  </p>
                </div>
              )
            )}
          </div>
        </div>
      </div>

      {/* Season Selector Tabs */}
      <div className="px-6 md:px-16 py-4 border-b border-white/10 bg-black/85 backdrop-blur-2xl sticky top-20 z-40 flex items-center justify-between overflow-x-auto no-scrollbar gap-4">
        <div className="flex items-center space-x-3 flex-none">
          <span className="text-xs font-bold uppercase tracking-wider text-white/50 mr-1 flex-none">
            Seasons
          </span>
          <div className="flex items-center space-x-1.5 bg-white/10 p-1 rounded-full border border-white/10 flex-none">
            {seasons.map((s) => (
              <button
                key={s}
                onClick={() => setActiveSeason(s)}
                className={`px-5 py-1.5 rounded-full text-xs font-semibold tracking-tight transition-all active:scale-95 ${
                  activeSeason === s
                    ? 'bg-white text-black shadow-md'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                Season {s}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs font-medium text-white/50 flex-none">
          {episodes.length} {episodes.length === 1 ? 'Episode' : 'Episodes'} in Season {activeSeason}
        </span>
      </div>

      {/* Episodes List View */}
      <div className="px-6 md:px-16 py-8 space-y-4 max-w-7xl mx-auto">
        {episodes.map((ep) => {
          const epNum = ep.episodeNumber;
          const tmdbEp = seasonEpisodesMap[epNum];
          const epTitle = tmdbEp?.name || ep.title || `Episode ${epNum}`;
          const epOverview = tmdbEp?.overview || '';
          const epRating = tmdbEp?.voteAverage;
          const epRuntime = tmdbEp?.runtime;
          const epAirDate = tmdbEp?.airDate
            ? new Date(tmdbEp.airDate).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : undefined;

          const stillImg = getTMDBImageUrl(tmdbEp?.stillPath || null, 'w500') || backdropUrl;
          const epSizeMb = Math.round(ep.videoItem.fileSize / (1024 * 1024));

          // Watch Progress calculation
          const wp = progressMap.get(ep.videoItem.id);
          const isWatched = wp && wp.duration > 0 && (wp.currentTime / wp.duration) >= 0.90;
          const hasResume = wp && wp.duration > 0 && !isWatched && wp.currentTime > 15;
          const progressPercent = hasResume ? Math.round((wp.currentTime / wp.duration) * 100) : 0;
          const timeLeftMin = hasResume ? Math.max(1, Math.round((wp.duration - wp.currentTime) / 60)) : 0;

          return (
            <div
              key={ep.id}
              onClick={() => onPlayEpisode(ep.videoItem)}
              className="group relative flex flex-col md:flex-row items-stretch p-4 md:p-5 rounded-3xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/25 transition-all duration-300 cursor-pointer active:scale-[0.99] shadow-lg gap-5 overflow-hidden"
            >
              {/* 16:9 Episode Still Thumbnail Preview */}
              <div className="relative flex-none w-full md:w-[260px] lg:w-[300px] aspect-[16/9] rounded-2xl overflow-hidden bg-[#141416] border border-white/10">
                {stillImg ? (
                  <img
                    src={stillImg}
                    alt={epTitle}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-tr from-zinc-800 to-black flex items-center justify-center">
                    <Film className="w-8 h-8 text-white/30" />
                  </div>
                )}

                {/* Floating Episode Number Pill */}
                <div className="absolute top-2.5 left-2.5 px-2.5 py-0.5 rounded-full bg-black/70 backdrop-blur-md text-[10px] font-bold text-white border border-white/15 uppercase tracking-wider">
                  EP {epNum}
                </div>

                {/* Watched Badge on Thumbnail */}
                {isWatched && (
                  <div className="absolute top-2.5 right-2.5 flex items-center space-x-1 px-2 py-0.5 rounded-full bg-emerald-500/90 backdrop-blur-md text-white text-[10px] font-bold uppercase tracking-wider border border-emerald-400/40">
                    <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                    <span>Watched</span>
                  </div>
                )}

                {/* Center Hover Play Button */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-white text-black flex items-center justify-center shadow-2xl shadow-black/80 transform scale-90 group-hover:scale-100 transition-transform">
                    <Play className="w-5 h-5 fill-black ml-0.5" />
                  </div>
                </div>

                {/* In-Progress Bottom Progress Bar */}
                {hasResume && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                    <div
                      className="h-full bg-white rounded-full transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Episode Metadata & Overview */}
              <div className="flex flex-col justify-between flex-1 min-w-0 space-y-3">
                <div className="space-y-2">
                  {/* Title and Rating Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center space-x-2.5 min-w-0">
                      <h4 className="font-bold text-base md:text-lg text-white group-hover:text-white transition-colors tracking-tight truncate">
                        {epNum}. {epTitle}
                      </h4>
                    </div>

                    {/* Rating Pill */}
                    {epRating && epRating > 0 ? (
                      <div className="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-white/10 text-[11px] font-bold text-white border border-white/15">
                        <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                        <span>{epRating.toFixed(1)}</span>
                      </div>
                    ) : null}
                  </div>

                  {/* Metadata tags: runtime, airDate, resolution, fileSize */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-white/60 font-medium">
                    {epRuntime && (
                      <span className="flex items-center text-white/70">
                        <Clock className="w-3 h-3 mr-1" />
                        {epRuntime} min
                      </span>
                    )}

                    {epAirDate && (
                      <>
                        <span>&bull;</span>
                        <span>{epAirDate}</span>
                      </>
                    )}

                    {ep.videoItem.parsed.resolution && (
                      <>
                        <span>&bull;</span>
                        <span className="px-1.5 py-0.2 rounded border border-white/20 text-[10px] font-semibold text-white/80">
                          {ep.videoItem.parsed.resolution}
                        </span>
                      </>
                    )}

                    <span>&bull;</span>
                    <span>
                      {epSizeMb > 1024 ? `${(epSizeMb / 1024).toFixed(1)} GB` : `${epSizeMb} MB`}
                    </span>
                  </div>

                  {/* Synopsis / Episode Overview */}
                  {epOverview ? (
                    <p className="text-xs md:text-sm text-white/65 line-clamp-2 md:line-clamp-3 leading-relaxed">
                      {epOverview}
                    </p>
                  ) : (
                    <p className="text-xs text-white/40 italic">
                      Episode {epNum} of {series.showTitle}. Ready to stream directly.
                    </p>
                  )}
                </div>

                {/* Bottom Action Row */}
                <div className="flex items-center justify-between pt-1">
                  <div className="text-xs font-semibold text-white/50">
                    {hasResume && (
                      <span className="text-white/80">
                        Resume from {Math.round(wp.currentTime / 60)}m ({timeLeftMin}m remaining)
                      </span>
                    )}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayEpisode(ep.videoItem);
                    }}
                    className="flex items-center space-x-2 px-5 py-2 rounded-full bg-white/10 group-hover:bg-white text-white group-hover:text-black text-xs font-semibold transition-all shadow-md active:scale-95 border border-white/15"
                  >
                    {hasResume ? (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Resume</span>
                      </>
                    ) : isWatched ? (
                      <>
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Replay</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Play Episode</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
