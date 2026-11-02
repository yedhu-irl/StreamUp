import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { HeroBannerCarousel } from './components/HeroBannerCarousel';
import { MediaRow } from './components/MediaRow';
import { ContinueWatchingRow } from './components/ContinueWatchingRow';
import { SeriesModal } from './components/SeriesModal';
import { MediaDetailModal } from './components/MediaDetailModal';
import { Player } from './components/Player';
import { PreRollScreen } from './components/PreRollScreen';
import { AuthModal } from './components/AuthModal';
import { ChannelManagerModal } from './components/ChannelManagerModal';
import { SearchModal } from './components/SearchModal';
import { ProfileScreen } from './components/ProfileScreen';
import { 
  db, 
  getStoredCredentials, 
  getStoredSession, 
  getRecentWatchProgress, 
  toggleBookmark, 
  type BookmarkRecord 
} from './services/db';
import { 
  initTelegramClient, 
  isUserAuthorized, 
  enrichVideosWithTMDB, 
  autoSyncAllChannels,
  initServiceWorkerPortBridge,
  getTelegramUserProfile
} from './services/telegram';
import { fetchTMDBMetadata } from './services/tmdb';
import { ensureStreamServiceWorker } from './services/swRegistration';
import type { 
  ChannelCategory, 
  ChannelVideoItem, 
  WatchProgress, 
  SeriesGroup,
  TelegramUserProfile 
} from './types';

export function App() {
  // Navigation & View States
  const [activeTab, setActiveTab] = useState<string>('all');

  // Telegram Auth States
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [userProfile, setUserProfile] = useState<TelegramUserProfile | null>(null);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  // Full Screen Views & Panels
  const [showChannelManager, setShowChannelManager] = useState<boolean>(false);
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [showProfile, setShowProfile] = useState<boolean>(false);
  const [selectedSeries, setSelectedSeries] = useState<SeriesGroup | null>(null);
  const [selectedDetailItem, setSelectedDetailItem] = useState<ChannelVideoItem | null>(null);

  // Player & Pre-Roll Staging States
  const [stagingMediaItem, setStagingMediaItem] = useState<ChannelVideoItem | null>(null);
  const [stagingInitialTime, setStagingInitialTime] = useState<number>(0);
  const [activePlayingItem, setActivePlayingItem] = useState<ChannelVideoItem | null>(null);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);

  const handleInitiatePlay = (item: ChannelVideoItem, initialTime = 0) => {
    setStagingMediaItem(item);
    setStagingInitialTime(initialTime);
    setActivePlayingItem(null);
  };

  // Data States
  const [channels, setChannels] = useState<ChannelCategory[]>([]);
  const [videos, setVideos] = useState<ChannelVideoItem[]>([]);
  const [continueWatching, setContinueWatching] = useState<WatchProgress[]>([]);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());

  // 1. Register Stream Service Worker on Boot & verify ping readiness barrier
  useEffect(() => {
    ensureStreamServiceWorker()
      .then(() => {
        initServiceWorkerPortBridge();
      })
      .catch((err) => {
        console.error('Service Worker readiness failed:', err);
      });
  }, []);

  // 2. Initialize Telegram & Load Database
  const initializeAuth = useCallback(async () => {
    try {
      const creds = await getStoredCredentials();
      const session = await getStoredSession();

      if (creds && session) {
        await initTelegramClient(creds, session.stringSession);
        const authorized = await isUserAuthorized();
        setIsLoggedIn(authorized);
        if (!authorized) {
          setShowAuthModal(true);
        } else {
          getTelegramUserProfile().then((prof) => {
            if (prof) setUserProfile(prof);
          });
          // Background auto-sync of channels to detect any newly uploaded movies
          autoSyncAllChannels().then((newCount) => {
            if (newCount > 0) {
              loadAppData();
            }
          }).catch(() => {});
        }
      } else {
        setShowAuthModal(true);
      }
    } catch (err) {
      console.warn('Telegram auth initialization failed:', err);
      setShowAuthModal(true);
    }
  }, []);

  useEffect(() => {
    initializeAuth();
    loadAppData();
  }, [initializeAuth]);

  // Load Channels, Videos, Progress, and Bookmarks
  const loadAppData = async () => {
    try {
      const storedChannels = await db.channels.toArray();
      setChannels(storedChannels);

      const storedVideos = await db.videos.toArray();
      setVideos(storedVideos);

      // Progressive TMDB enrichment for any stored videos missing posters
      const unenriched = storedVideos.filter((v) => !v.tmdb || !v.tmdb.posterPath);
      if (unenriched.length > 0) {
        enrichVideosWithTMDB(unenriched, (updatedItem) => {
          setVideos((prev) =>
            prev.map((v) => (v.id === updatedItem.id ? { ...v, tmdb: updatedItem.tmdb } : v))
          );
        });
      }

      // Progressive TMDB enrichment for series shows missing metadata
      const storedChannelsMap = new Map(storedChannels.map((c) => [c.id, c]));
      const seriesUnenriched = storedVideos.filter(
        (v) =>
          (v.parsed.isSeries || storedChannelsMap.get(v.channelId)?.contentType === 'series') &&
          (!v.tmdb || !v.tmdb.posterPath)
      );

      const showNamesToFetch = new Set(seriesUnenriched.map((v) => v.parsed.cleanTitle));
      showNamesToFetch.forEach((cleanTitle) => {
        fetchTMDBMetadata(cleanTitle, undefined, true).then((meta) => {
          if (meta) {
            setVideos((prev) =>
              prev.map((v) =>
                v.parsed.cleanTitle.toLowerCase().trim() === cleanTitle.toLowerCase().trim()
                  ? { ...v, tmdb: v.tmdb?.posterPath ? v.tmdb : meta }
                  : v
              )
            );
            storedVideos
              .filter((v) => v.parsed.cleanTitle.toLowerCase().trim() === cleanTitle.toLowerCase().trim())
              .forEach((v) => {
                if (!v.tmdb?.posterPath) {
                  db.videos.update(v.id, { tmdb: meta });
                }
              });
          }
        });
      });

      const progress = await getRecentWatchProgress(15);
      setContinueWatching(progress);

      const bookmarks = await db.bookmarks.toArray();
      setBookmarkedIds(new Set(bookmarks.map((b) => b.id)));
    } catch (err) {
      console.error('Error loading app data:', err);
    }
  };

  // Video Map for O(1) lookup
  const videoMap = useMemo(() => {
    const map = new Map<string, ChannelVideoItem>();
    videos.forEach((v) => map.set(v.id, v));
    return map;
  }, [videos]);

  // 1. Group Series files into SeriesGroup hierarchy by show title
  const seriesGroups = useMemo(() => {
    const groups = new Map<string, SeriesGroup>();
    const channelMap = new Map<string, ChannelCategory>();
    channels.forEach((c) => channelMap.set(c.id, c));

    const seriesVideos = videos.filter(
      (v) => v.parsed.isSeries || channelMap.get(v.channelId)?.contentType === 'series'
    );

    seriesVideos.forEach((v) => {
      const showTitle = v.tmdb?.title || v.parsed.cleanTitle;
      const showKey = showTitle.toLowerCase().trim();

      if (!groups.has(showKey)) {
        groups.set(showKey, {
          showTitle,
          tmdb: v.tmdb || null,
          seasons: {},
          totalEpisodes: 0,
          channelId: v.channelId,
        });
      }

      const grp = groups.get(showKey)!;
      if (!grp.tmdb && v.tmdb) {
        grp.tmdb = v.tmdb;
      }

      const seasonNum = v.parsed.season || 1;
      const epNum = v.parsed.episode || 1;

      if (!grp.seasons[seasonNum]) {
        grp.seasons[seasonNum] = [];
      }

      const alreadyHas = grp.seasons[seasonNum].some((e) => e.videoItem.id === v.id);
      if (!alreadyHas) {
        const epTitle = v.parsed.episode
          ? `Episode ${v.parsed.episode}`
          : `Episode ${grp.seasons[seasonNum].length + 1}`;

        grp.seasons[seasonNum].push({
          id: v.id,
          episodeNumber: epNum,
          seasonNumber: seasonNum,
          title: epTitle,
          videoItem: {
            ...v,
            parsed: {
              ...v.parsed,
              isSeries: true,
              cleanTitle: showTitle,
              season: seasonNum,
              episode: epNum,
            },
            tmdb: v.tmdb || grp.tmdb,
          },
        });
        grp.totalEpisodes += 1;
      }
    });

    // Sort episodes inside seasons
    groups.forEach((grp) => {
      Object.keys(grp.seasons).forEach((s) => {
        grp.seasons[Number(s)].sort((a, b) => {
          if (a.episodeNumber !== b.episodeNumber) {
            return a.episodeNumber - b.episodeNumber;
          }
          return a.videoItem.messageId - b.videoItem.messageId;
        });
      });
    });

    return Array.from(groups.values());
  }, [videos, channels]);

  // 2. Map of distinct Show Representative Cards (one per show)
  const seriesShowItemMap = useMemo(() => {
    const map = new Map<string, ChannelVideoItem>();
    seriesGroups.forEach((grp) => {
      const showKey = grp.showTitle.toLowerCase().trim();
      const firstSeasonKey = Object.keys(grp.seasons).sort((a, b) => Number(a) - Number(b))[0];
      const firstEp = grp.seasons[Number(firstSeasonKey)]?.[0]?.videoItem;
      if (!firstEp) return;

      const showItem: ChannelVideoItem = {
        ...firstEp,
        id: `series_show_${encodeURIComponent(showKey)}`,
        fileName: grp.showTitle,
        parsed: {
          ...firstEp.parsed,
          cleanTitle: grp.showTitle,
          originalFileName: grp.showTitle,
          isSeries: true,
          season: 1,
          episode: 1,
        },
        tmdb: grp.tmdb || firstEp.tmdb,
      };
      map.set(showKey, showItem);
    });
    return map;
  }, [seriesGroups]);

  // 3. Helper to collapse raw video lists so series appear as ONE single show card
  const collapseChannelVideos = useCallback(
    (rawVideos: ChannelVideoItem[]): ChannelVideoItem[] => {
      const result: ChannelVideoItem[] = [];
      const seenShowKeys = new Set<string>();
      const channelMap = new Map<string, ChannelCategory>();
      channels.forEach((c) => channelMap.set(c.id, c));

      for (const v of rawVideos) {
        const isSeries = v.parsed.isSeries || channelMap.get(v.channelId)?.contentType === 'series';
        if (isSeries) {
          const showTitle = v.tmdb?.title || v.parsed.cleanTitle;
          const showKey = showTitle.toLowerCase().trim();
          if (!seenShowKeys.has(showKey)) {
            seenShowKeys.add(showKey);
            const rep = seriesShowItemMap.get(showKey);
            if (rep) {
              result.push(rep);
            } else {
              result.push({
                ...v,
                id: `series_show_${encodeURIComponent(showKey)}`,
                parsed: { ...v.parsed, isSeries: true, cleanTitle: showTitle },
              });
            }
          }
        } else {
          result.push(v);
        }
      }
      return result;
    },
    [channels, seriesShowItemMap]
  );

  // 4. Watch Progress Map and In-Progress / Watched Partitioning
  const progressMap = useMemo(() => {
    return new Map(continueWatching.map((p) => [p.id, p]));
  }, [continueWatching]);

  const { seriesInProgress, moviesInProgress, moviesWatched } = useMemo(() => {
    const sList: WatchProgress[] = [];
    const mList: WatchProgress[] = [];
    const wList: WatchProgress[] = [];
    const channelMap = new Map<string, ChannelCategory>();
    channels.forEach((c) => channelMap.set(c.id, c));

    for (const p of continueWatching) {
      const v = videoMap.get(p.id);
      const isSeries =
        v?.parsed.isSeries ||
        Boolean(p.episodeInfo) ||
        (v && channelMap.get(v.channelId)?.contentType === 'series');
      const pct = p.duration > 0 ? (p.currentTime / p.duration) * 100 : 0;

      if (isSeries) {
        if (p.currentTime > 15) {
          sList.push(p);
        }
      } else {
        if (pct >= 90) {
          wList.push(p);
        } else if (pct >= 2 && p.currentTime > 15) {
          mList.push(p);
        }
      }
    }

    return {
      seriesInProgress: sList,
      moviesInProgress: mList,
      moviesWatched: wList,
    };
  }, [continueWatching, videoMap, channels]);

  // 5. Featured items for Billboard Banner Carousel (Distinct titles only, never duplicate episodes)
  const featuredVideos = useMemo(() => {
    const collapsed = collapseChannelVideos(videos);
    const withBackdrop = collapsed.filter((v) => v.tmdb?.backdropPath);
    if (withBackdrop.length >= 6) return withBackdrop.slice(0, 6);
    const withPoster = collapsed.filter((v) => v.tmdb?.posterPath && !withBackdrop.includes(v));
    const combined = [...withBackdrop, ...withPoster];
    if (combined.length >= 6) return combined.slice(0, 6);
    const others = collapsed.filter((v) => !combined.includes(v));
    return [...combined, ...others].slice(0, 6);
  }, [videos, collapseChannelVideos]);

  // 6. Shelves and Rows for Active Tab
  const displayRows = useMemo(() => {
    const channelMap = new Map<string, ChannelCategory>();
    channels.forEach((c) => channelMap.set(c.id, c));

    if (activeTab === 'movies') {
      return channels
        .filter((ch) => ch.enabled !== false && ch.contentType !== 'series')
        .map((ch) => {
          const channelMovies = videos.filter(
            (v) => v.channelId === ch.id && !v.parsed.isSeries
          );
          return {
            id: `movies_${ch.id}`,
            title: ch.title,
            items: channelMovies,
          };
        })
        .filter((row) => row.items.length > 0);
    }

    if (activeTab === 'series') {
      const allShows = Array.from(seriesShowItemMap.values());
      return allShows.length > 0
        ? [{ id: 'all-tv-series', title: 'TV Shows & Series', items: allShows }]
        : [];
    }

    if (activeTab === 'activity' || activeTab === 'mylist') {
      const rows: Array<{ id: string; title: string; items: ChannelVideoItem[] }> = [];

      // My Watchlist (saved bookmarks, collapsed so series show as 1 card)
      const bookmarkedVideos = videos.filter((v) => bookmarkedIds.has(v.id));
      const collapsedWatchlist = collapseChannelVideos(bookmarkedVideos);
      if (collapsedWatchlist.length > 0) {
        rows.push({
          id: 'my-watchlist-row',
          title: 'My Watchlist',
          items: collapsedWatchlist,
        });
      }

      // Watched Movies (movies with >= 90% progress)
      const watchedMovieItems: ChannelVideoItem[] = [];
      const seenWatchedIds = new Set<string>();
      for (const p of moviesWatched) {
        const v = videoMap.get(p.id);
        if (v && !seenWatchedIds.has(v.id)) {
          seenWatchedIds.add(v.id);
          watchedMovieItems.push(v);
        }
      }
      if (watchedMovieItems.length > 0) {
        rows.push({
          id: 'watched-movies-row',
          title: 'Watched • Completed Movies',
          items: watchedMovieItems,
        });
      }

      return rows;
    }

    // Default Home Tab: Each channel gets its row with series collapsed into 1 show card
    return channels
      .filter((ch) => ch.enabled !== false)
      .map((ch) => {
        const channelVideos = videos.filter((v) => v.channelId === ch.id);
        const collapsed = collapseChannelVideos(channelVideos);
        return {
          id: ch.id,
          title: ch.title,
          items: collapsed,
        };
      })
      .filter((row) => row.items.length > 0);
  }, [
    activeTab,
    videos,
    channels,
    seriesShowItemMap,
    collapseChannelVideos,
    bookmarkedIds,
    moviesWatched,
    videoMap,
  ]);

  // Media Selection Handler: Opens the Apple TV rich detail modal or series modal
  const handleSelectMedia = (item: ChannelVideoItem) => {
    const isSeries =
      item.parsed.isSeries ||
      item.id.startsWith('series_show_') ||
      channels.find((c) => c.id === item.channelId)?.contentType === 'series';

    if (isSeries) {
      const showKey = (item.tmdb?.title || item.parsed.cleanTitle).toLowerCase().trim();
      const match = seriesGroups.find(
        (g) =>
          g.showTitle.toLowerCase().trim() === showKey ||
          g.tmdb?.title?.toLowerCase().trim() === showKey
      );
      if (match) {
        setSelectedSeries(match);
        return;
      }
    }
    setSelectedDetailItem(item);
  };

  const handleResumePlay = (item: ChannelVideoItem, resumeTime: number) => {
    handleInitiatePlay(item, resumeTime);
  };

  const handleToggleBookmark = async (item: ChannelVideoItem) => {
    const record: BookmarkRecord = {
      id: item.id,
      title: item.tmdb?.title || item.parsed.cleanTitle,
      posterPath: item.tmdb?.posterPath || null,
      backdropPath: item.tmdb?.backdropPath || null,
      isSeries: item.parsed.isSeries,
      addedAt: Date.now(),
    };
    const isNowBookmarked = await toggleBookmark(record);
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (isNowBookmarked) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  };

  // Find next episode in series or next movie in channel
  const getNextEpisode = (current: ChannelVideoItem): ChannelVideoItem | null => {
    if (current.parsed.isSeries) {
      const titleKey = (current.tmdb?.title || current.parsed.cleanTitle).toLowerCase();
      const grp = seriesGroups.find((g) => g.showTitle.toLowerCase() === titleKey);
      if (grp) {
        const currentSeason = current.parsed.season || 1;
        const currentEp = current.parsed.episode || 1;

        const seasonList = grp.seasons[currentSeason];
        if (seasonList) {
          const nextInSeason = seasonList.find((e) => e.episodeNumber === currentEp + 1);
          if (nextInSeason) return nextInSeason.videoItem;
        }

        // Next season episode 1
        const nextSeasonList = grp.seasons[currentSeason + 1];
        if (nextSeasonList && nextSeasonList.length > 0) {
          return nextSeasonList[0].videoItem;
        }
      }
    }

    // Fallback: Next video item in same channel
    const chVideos = videos.filter((v) => v.channelId === current.channelId);
    const curIdx = chVideos.findIndex((v) => v.id === current.id);
    if (curIdx !== -1 && curIdx + 1 < chVideos.length) {
      return chVideos[curIdx + 1];
    }

    return null;
  };

  return (
    <div className="min-h-screen bg-black text-white selection:bg-white selection:text-black antialiased font-sans">
      {/* Pinned Translucent Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenSearch={() => setShowSearch(true)}
        onOpenProfile={() => setShowProfile(true)}
        onOpenChannelManager={() => setShowChannelManager(true)}
        isLoggedIn={isLoggedIn}
        userProfile={userProfile}
      />

      <main className="pt-20 pb-24">
        {/* Apple TV 6-Item Auto-Advancing Billboard Banner Carousel (Home view only) */}
        {activeTab === 'all' && (
          <HeroBannerCarousel
            items={featuredVideos}
            onPlay={(item) => {
              if (item.id.startsWith('series_show_') || item.parsed.isSeries) {
                handleSelectMedia(item);
                return;
              }
              handleInitiatePlay(item, 0);
            }}
            onOpenDetails={(item) => handleSelectMedia(item)}
            isBookmarked={(id) => bookmarkedIds.has(id)}
            onToggleBookmark={handleToggleBookmark}
          />
        )}

        {/* Home Screen: Currently Watching Series & Resume Movies */}
        {activeTab === 'all' && (
          <>
            {seriesInProgress.length > 0 && (
              <ContinueWatchingRow
                title="Currently Watching • TV Shows"
                progressList={seriesInProgress}
                videoMap={videoMap}
                onResume={handleResumePlay}
                rowOrder={2}
              />
            )}
            {moviesInProgress.length > 0 && (
              <ContinueWatchingRow
                title="Resume Watching • Movies"
                progressList={moviesInProgress}
                videoMap={videoMap}
                onResume={handleResumePlay}
                rowOrder={3}
              />
            )}
          </>
        )}

        {/* My Activity Screen: In-Progress Series & Resume Movies */}
        {(activeTab === 'activity' || activeTab === 'mylist') && (
          <>
            {seriesInProgress.length > 0 && (
              <ContinueWatchingRow
                title="Currently Watching • TV Shows"
                progressList={seriesInProgress}
                videoMap={videoMap}
                onResume={handleResumePlay}
                rowOrder={1}
              />
            )}
            {moviesInProgress.length > 0 && (
              <ContinueWatchingRow
                title="Resume Watching • Movies"
                progressList={moviesInProgress}
                videoMap={videoMap}
                onResume={handleResumePlay}
                rowOrder={2}
              />
            )}
          </>
        )}

        {/* Category Rows */}
        <div className="space-y-4 mt-4">
          {displayRows.map((row, index) => (
            <MediaRow
              key={row.id}
              title={row.title}
              items={row.items}
              onSelect={handleSelectMedia}
              progressMap={progressMap}
              rowOrder={index + 4}
            />
          ))}

          {displayRows.length === 0 && seriesInProgress.length === 0 && moviesInProgress.length === 0 && (
            <div className="text-center py-28 text-white/50 space-y-3">
              <p className="text-base font-medium">
                {activeTab === 'activity' || activeTab === 'mylist'
                  ? 'No activity or saved items yet. Start streaming to track your progress.'
                  : 'No media available in this category.'}
              </p>
              <button
                onClick={() => setShowChannelManager(true)}
                className="px-6 py-3 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-xs shadow-xl transition-all"
              >
                Connect Channels
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Apple TV Full-Screen Media Detail View */}
      {selectedDetailItem && (
        <MediaDetailModal
          item={selectedDetailItem}
          allVideos={videos}
          channels={channels}
          onClose={() => setSelectedDetailItem(null)}
          onPlay={(item, resumeTime) => {
            setSelectedDetailItem(null);
            handleInitiatePlay(item, resumeTime || 0);
          }}
          onOpenSeries={(item) => {
            const titleKey = (item.tmdb?.title || item.parsed.cleanTitle).toLowerCase();
            const match = seriesGroups.find(
              (g) => g.showTitle.toLowerCase() === titleKey || g.tmdb?.title?.toLowerCase() === titleKey
            );
            if (match) {
              setSelectedDetailItem(null);
              setSelectedSeries(match);
            }
          }}
          onSelectMedia={(item) => setSelectedDetailItem(item)}
          isBookmarked={bookmarkedIds.has(selectedDetailItem.id)}
          onToggleBookmark={handleToggleBookmark}
        />
      )}

      {/* Series Season & Episodes View */}
      {selectedSeries && (
        <SeriesModal
          series={selectedSeries}
          onClose={() => setSelectedSeries(null)}
          onPlayEpisode={(ep) => {
            setSelectedSeries(null);
            handleInitiatePlay(ep, 0);
          }}
        />
      )}

      {/* Fullscreen Pre-Roll Staging Screen */}
      {stagingMediaItem && (
        <PreRollScreen
          item={stagingMediaItem}
          initialTime={stagingInitialTime}
          onReady={() => {
            setActivePlayingItem(stagingMediaItem);
            setPlayerInitialTime(stagingInitialTime);
            setStagingMediaItem(null);
          }}
          onCancel={() => {
            setStagingMediaItem(null);
          }}
        />
      )}

      {/* Fullscreen Player */}
      {activePlayingItem && (
        <Player
          item={activePlayingItem}
          initialTime={playerInitialTime}
          onClose={() => {
            setActivePlayingItem(null);
            loadAppData(); // Refresh continue watching
          }}
          nextEpisode={getNextEpisode(activePlayingItem)}
          onPlayNextEpisode={(next) => {
            handleInitiatePlay(next, 0);
          }}
        />
      )}

      {/* Global Search Drawer */}
      {showSearch && (
        <SearchModal
          videos={videos}
          channels={channels}
          collapseVideos={collapseChannelVideos}
          progressMap={progressMap}
          onSelect={handleSelectMedia}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Channel & Category Manager */}
      {showChannelManager && (
        <ChannelManagerModal
          onClose={() => setShowChannelManager(false)}
          onChannelsUpdated={loadAppData}
        />
      )}

      {/* Full-Screen Profile & Settings View */}
      {showProfile && (
        <ProfileScreen
          onClose={() => setShowProfile(false)}
          onLogout={() => {
            setIsLoggedIn(false);
            setUserProfile(null);
            setShowAuthModal(true);
          }}
          onChannelsUpdated={loadAppData}
        />
      )}

      {/* Auth Modal (Untouched session & credentials) */}
      {showAuthModal && (
        <AuthModal
          onSuccess={() => {
            setShowAuthModal(false);
            setIsLoggedIn(true);
            loadAppData();
          }}
          onClose={() => setShowAuthModal(false)}
        />
      )}
    </div>
  );
}
export default App;
