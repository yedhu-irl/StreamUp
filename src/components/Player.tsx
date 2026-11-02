import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Volume1,
  Maximize,
  Minimize,
  Subtitles,
  Gauge,
  ArrowLeft,
  FastForward,
  Loader2,
  AlertCircle,
  Check,
  Wifi,
  Moon,
  Bookmark,
  Repeat,
  Undo2,
  Monitor,
} from 'lucide-react';
import type { ChannelVideoItem, SubtitleTrack } from '../types';
import { saveWatchProgress } from '../services/db';
import { streamDb } from '../db/streamDb';
import { resolveCachedDocument, fetchSubtitleContent } from '../services/telegram';
import { tgStreamEngine, type TelemetryEvent } from '../services/tgStreamEngine';
import { ensureStreamServiceWorker } from '../services/swRegistration';
import { PlayerEngine } from '../services/playerEngine';
import { PlayerTimebar } from './PlayerTimebar';
import type { ByteRange } from '../services/windowPlanner';

interface PlayerProps {
  item: ChannelVideoItem;
  initialTime?: number;
  onClose: () => void;
  nextEpisode?: ChannelVideoItem | null;
  onPlayNextEpisode?: (next: ChannelVideoItem) => void;
}

type AspectRatioMode = 'fit' | 'fill' | 'stretch' | '16:9' | '4:3';

export const Player: React.FC<PlayerProps> = ({
  item,
  initialTime = 0,
  onClose,
  nextEpisode,
  onPlayNextEpisode,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerEngineRef = useRef<PlayerEngine | null>(null);

  // Core Playback State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(initialTime);
  const [duration, setDuration] = useState<number>(item.duration || 0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isBuffering, setIsBuffering] = useState<boolean>(true);
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<string>('Preparing stream...');

  // Telemetry & Buffer State
  const [transferSpeed, setTransferSpeed] = useState<number>(0);
  const [downloadedRanges, setDownloadedRanges] = useState<ByteRange[]>([]);
  const [isStalled, setIsStalled] = useState<boolean>(false);
  const [activeChunkIndex, setActiveChunkIndex] = useState<number>(0);

  // Debounced Seek & Jump Back State
  const [seekRippleText, setSeekRippleText] = useState<string | null>(null);
  const [jumpBackTarget, setJumpBackTarget] = useState<number | null>(null);
  const seekAccumulatorRef = useRef<number>(0);
  const seekDebounceTimerRef = useRef<any>(null);
  const jumpBackTimerRef = useRef<any>(null);
  const rippleTimerRef = useRef<any>(null);
  const lastPruneTimeRef = useRef<number>(0);

  // Advanced Features State
  const [nightMode, setNightMode] = useState<boolean>(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('fit');
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Array<{ id: string; timeSec: number; note: string }>>([]);

  // Subtitles
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string>('off');
  const [showSubMenu, setShowSubMenu] = useState<boolean>(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState<boolean>(false);

  // Next Episode Countdown
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);

  const controlsTimeoutRef = useRef<any>(null);
  const streamId = `${item.channelId}_${item.messageId}`;

  // Format seconds to HH:MM:SS / MM:SS
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

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec <= 0) return '0 KB/s';
    if (bytesPerSec >= 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
  };

  // ────────────────────────────────────────────
  // Stream Engine Initialization
  // ────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    setPlaybackError(null);
    setIsBuffering(true);
    setPlaybackStatus('Verifying stream proxy...');

    const initEngine = async () => {
      // 1. Service Worker verification barrier
      await ensureStreamServiceWorker();

      // 2. Resolve cached document and register in TgStreamEngine
      const cached = await resolveCachedDocument(item.channelId, item.messageId);
      if (!cached || !cached.doc) {
        if (isMounted) {
          setPlaybackError('Could not resolve Telegram media document.');
          setIsBuffering(false);
        }
        return;
      }

      const fileName = item.fileName || item.parsed?.originalFileName || 'video.mp4';
      await tgStreamEngine.registerStream(
        item.channelId,
        item.messageId,
        cached.doc,
        fileName,
        cached.mimeType || 'video/mp4'
      );

      // Load saved series playback speed & bookmarks
      try {
        const savedProg = await streamDb.playbackProgress.get(streamId);
        if (savedProg && isMounted) {
          if (savedProg.playbackSpeed) setPlaybackSpeed(savedProg.playbackSpeed);
          if (savedProg.bookmarks) setBookmarks(savedProg.bookmarks);
        }
      } catch (e) {}

      // 3. Initialize Dual-Path Player Engine
      if (!videoRef.current || !isMounted) return;

      const engine = new PlayerEngine({
        videoElement: videoRef.current,
        streamId,
        fileName,
        mimeType: cached.mimeType || 'video/mp4',
        fileSize: cached.size || item.fileSize,
        initialTime,
        onReady: (dur) => {
          if (!isMounted) return;
          if (dur > 0) setDuration(dur);
          setIsBuffering(false);
        },
        onStatus: (status) => {
          if (isMounted) setPlaybackStatus(status);
        },
        onError: (err) => {
          if (isMounted) {
            setPlaybackError(err);
            setIsBuffering(false);
          }
        },
      });

      playerEngineRef.current = engine;
      await engine.start();
    };

    initEngine();

    // Telemetry subscription
    const unsubTelemetry = tgStreamEngine.subscribeTelemetry((ev: TelemetryEvent) => {
      if (!isMounted) return;
      setTransferSpeed(ev.speedBytesPerSec);
      setDownloadedRanges(ev.downloadedRanges);
      setIsStalled(ev.isStalled);
      setActiveChunkIndex(ev.activeChunkIndex);
    });

    return () => {
      isMounted = false;
      unsubTelemetry();
      if (playerEngineRef.current) {
        playerEngineRef.current.destroy();
        playerEngineRef.current = null;
      }
    };
  }, [item.channelId, item.messageId, item.fileSize, streamId, initialTime]);

  // ────────────────────────────────────────────
  // Auto-Save Watch Progress
  // ────────────────────────────────────────────
  useEffect(() => {
    const saveInterval = setInterval(async () => {
      if (videoRef.current && videoRef.current.currentTime > 5) {
        const cTime = videoRef.current.currentTime;
        const dur = videoRef.current.duration || duration;

        saveWatchProgress({
          id: item.id,
          channelId: item.channelId,
          messageId: item.messageId,
          currentTime: cTime,
          duration: dur,
          updatedAt: Date.now(),
          title: item.tmdb?.title || item.parsed.cleanTitle,
          posterPath: item.tmdb?.posterPath || null,
          backdropPath: item.tmdb?.backdropPath || null,
          episodeInfo: item.parsed.isSeries
            ? `S${item.parsed.season || 1} E${item.parsed.episode || 1}`
            : undefined,
        });

        // Save progress & speed in streamDb
        await streamDb.playbackProgress.put({
          streamId,
          chatId: item.channelId,
          positionSec: cTime,
          durationSec: dur,
          completed: dur > 0 && cTime / dur >= 0.9,
          playbackSpeed,
          bookmarks,
          updatedAt: Date.now(),
        });
      }
    }, 5000);

    return () => clearInterval(saveInterval);
  }, [item, duration, streamId, playbackSpeed, bookmarks]);

  // Synchronize Volume & Mute to Video Element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // ────────────────────────────────────────────
  // Controls HUD Auto-Hide Loop
  // ────────────────────────────────────────────
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
        setShowSubMenu(false);
        setShowSpeedMenu(false);
      }, 4000);
    }
  }, [isPlaying]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [isPlaying, resetControlsTimeout]);

  // ────────────────────────────────────────────
  // Debounced Seek Execution (300ms)
  // ────────────────────────────────────────────
  const commitSeek = useCallback(
    (targetTime: number) => {
      const v = videoRef.current;
      if (!v) return;

      const previousTime = v.currentTime;
      const clampedTarget = Math.max(0, Math.min(targetTime, duration || 999999));

      // Show Jump Back pill if delta > 30s
      if (Math.abs(clampedTarget - previousTime) >= 30) {
        setJumpBackTarget(previousTime);
        if (jumpBackTimerRef.current) clearTimeout(jumpBackTimerRef.current);
        jumpBackTimerRef.current = setTimeout(() => setJumpBackTarget(null), 6000);
      }

      playerEngineRef.current?.seek(clampedTarget);
      setCurrentTime(clampedTarget);
      seekAccumulatorRef.current = 0;
    },
    [duration]
  );

  const handleRelativeSeek = useCallback(
    (deltaSec: number) => {
      const v = videoRef.current;
      if (!v) return;

      seekAccumulatorRef.current += deltaSec;
      const target = Math.max(0, Math.min(v.currentTime + seekAccumulatorRef.current, duration || 999999));
      setCurrentTime(target);

      // Ripple feedback
      const sign = seekAccumulatorRef.current > 0 ? `+${seekAccumulatorRef.current}s` : `${seekAccumulatorRef.current}s`;
      setSeekRippleText(sign);
      if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
      rippleTimerRef.current = setTimeout(() => setSeekRippleText(null), 800);

      // Debounce commit 300ms
      if (seekDebounceTimerRef.current) clearTimeout(seekDebounceTimerRef.current);
      seekDebounceTimerRef.current = setTimeout(() => {
        commitSeek(target);
      }, 300);

      resetControlsTimeout();
    },
    [duration, commitSeek, resetControlsTimeout]
  );

  // ────────────────────────────────────────────
  // Keyboard & TV D-Pad Spatial Navigation
  // ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // webOS GoBack code 461, Escape, Backspace
      if (e.key === 'Escape' || e.key === 'Backspace' || (e as any).keyCode === 461) {
        e.preventDefault();
        if (showControls) {
          setShowControls(false);
          setShowSubMenu(false);
          setShowSpeedMenu(false);
        } else {
          onClose();
        }
        return;
      }

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleRelativeSeek(-10);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleRelativeSeek(10);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        resetControlsTimeout();
        setVolume((v) => Math.min(1, v + 0.1));
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        resetControlsTimeout();
        setVolume((v) => Math.max(0, v - 0.1));
        return;
      }

      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setIsMuted((m) => !m);
        return;
      }

      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      resetControlsTimeout();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showControls, onClose, handleRelativeSeek, resetControlsTimeout]);

  // ────────────────────────────────────────────
  // Transport Controls
  // ────────────────────────────────────────────
  const togglePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
    resetControlsTimeout();
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleSpeedSelect = async (spd: number) => {
    setPlaybackSpeed(spd);
    if (videoRef.current) videoRef.current.playbackRate = spd;
    setShowSpeedMenu(false);

    // Save speed preference per series
    await streamDb.playbackProgress.put({
      streamId,
      chatId: item.channelId,
      positionSec: currentTime,
      durationSec: duration,
      completed: duration > 0 && currentTime / duration >= 0.9,
      playbackSpeed: spd,
      bookmarks,
      updatedAt: Date.now(),
    });
  };

  const handleNightModeToggle = () => {
    if (playerEngineRef.current) {
      const nextState = !nightMode;
      const success = playerEngineRef.current.toggleNightMode(nextState);
      setNightMode(success);
    }
  };

  const handleAddBookmark = () => {
    const newBm = {
      id: `bm_${Date.now()}`,
      timeSec: currentTime,
      note: `Bookmark at ${formatTime(currentTime)}`,
    };
    setBookmarks((prev) => [...prev, newBm]);
  };

  const handleABLoop = () => {
    if (loopA === null) {
      setLoopA(currentTime);
    } else if (loopB === null && currentTime > loopA) {
      setLoopB(currentTime);
    } else {
      setLoopA(null);
      setLoopB(null);
    }
  };

  // Enforce A-B loop boundary
  useEffect(() => {
    if (loopA !== null && loopB !== null && currentTime >= loopB) {
      playerEngineRef.current?.seek(loopA);
    }
  }, [currentTime, loopA, loopB]);

  // Cycle aspect ratio: Fit -> Fill -> Stretch -> 16:9 -> 4:3
  const cycleAspectRatio = () => {
    const modes: AspectRatioMode[] = ['fit', 'fill', 'stretch', '16:9', '4:3'];
    const nextIdx = (modes.indexOf(aspectRatio) + 1) % modes.length;
    setAspectRatio(modes[nextIdx]);
  };

  const getVideoAspectClass = (): string => {
    switch (aspectRatio) {
      case 'fill':
        return 'w-full h-full object-cover';
      case 'stretch':
        return 'w-full h-full object-fill';
      case '16:9':
        return 'w-full h-auto max-h-full aspect-video object-contain';
      case '4:3':
        return 'w-full h-auto max-h-full aspect-[4/3] object-contain';
      case 'fit':
      default:
        return 'w-full h-full object-contain';
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={resetControlsTimeout}
      onClick={resetControlsTimeout}
      className="fixed inset-0 z-50 bg-black text-white flex items-center justify-center select-none overflow-hidden font-sans"
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className={getVideoAspectClass()}
        playsInline
        onTimeUpdate={() => {
          if (videoRef.current) {
            const ct = videoRef.current.currentTime;
            setCurrentTime(ct);
            if (ct > 0.5) {
              setIsInitialLoading(false);
            }
            if (Math.abs(ct - lastPruneTimeRef.current) >= 4) {
              lastPruneTimeRef.current = ct;
              playerEngineRef.current?.onPlaybackProgress(ct);
            }
          }
        }}
        onDurationChange={() => {
          if (videoRef.current && videoRef.current.duration) setDuration(videoRef.current.duration);
        }}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => {
          setIsBuffering(false);
          setIsPlaying(true);
          setIsInitialLoading(false);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          if (nextEpisode && onPlayNextEpisode) {
            setCountdownSeconds(10);
          }
        }}
        onError={() => {
          const err = videoRef.current?.error;
          console.warn('Video element error event caught:', err?.code, err?.message);
        }}
      />

      {/* Ripple Seek Indicator (+10s / -10s) */}
      {seekRippleText && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-6 py-3 rounded-2xl bg-black/75 backdrop-blur-3xl border border-white/20 text-2xl font-bold tracking-tight shadow-2xl pointer-events-none animate-scale-up">
          {seekRippleText}
        </div>
      )}

      {/* Jump-Back Undo Pill (when seeking > 30s away) */}
      {jumpBackTarget !== null && (
        <button
          onClick={() => {
            commitSeek(jumpBackTarget);
            setJumpBackTarget(null);
          }}
          className="absolute bottom-28 left-8 z-40 flex items-center space-x-2 px-4 py-2.5 rounded-full bg-[#18181c]/90 border border-white/20 text-xs font-semibold text-white shadow-2xl backdrop-blur-2xl hover:bg-white/20 active:scale-95 transition-all animate-fade-in"
        >
          <Undo2 className="w-4 h-4 text-amber-400" />
          <span>Jump back to {formatTime(jumpBackTarget)}</span>
        </button>
      )}

      {/* Fullscreen Initial Pre-Roll Poster & Loading Screen */}
      {isInitialLoading && !playbackError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center p-6 bg-black overflow-hidden animate-fade-in">
          {/* Blurred Background Backdrop */}
          {item.tmdb?.backdropPath && (
            <div
              className="absolute inset-0 bg-cover bg-center opacity-30 blur-2xl scale-110 pointer-events-none"
              style={{
                backgroundImage: `url(https://image.tmdb.org/t/p/w1280${item.tmdb.backdropPath})`,
              }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/60 pointer-events-none" />

          {/* Close button so user can exit early */}
          <button
            onClick={onClose}
            className="absolute top-6 left-6 z-50 p-3 rounded-full bg-black/40 hover:bg-white/10 text-white/80 hover:text-white transition-all backdrop-blur-md"
            title="Close"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>

          {/* Pre-Roll Card */}
          <div className="relative z-10 max-w-2xl w-full flex flex-col md:flex-row items-center gap-6 p-6 rounded-3xl bg-[#141416]/90 border border-white/10 shadow-[0_25px_80px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            {item.tmdb?.posterPath ? (
              <img
                src={`https://image.tmdb.org/t/p/w342${item.tmdb.posterPath}`}
                alt={item.tmdb.title || item.parsed?.cleanTitle}
                className="w-32 md:w-40 rounded-2xl shadow-2xl object-cover shrink-0 border border-white/10"
              />
            ) : (
              <div className="w-32 h-48 md:w-40 md:h-56 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                <Play className="w-12 h-12 text-white/30" />
              </div>
            )}

            <div className="flex-1 text-center md:text-left space-y-3">
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2">
                <span className="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase bg-red-600/90 text-white">
                  {item.parsed?.resolution || 'HD'}
                </span>
                {item.parsed?.year && (
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-white/10 text-white/80">
                    {item.parsed.year}
                  </span>
                )}
                {item.fileSize > 0 && (
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-mono bg-white/10 text-white/60">
                    {formatFileSize(item.fileSize)}
                  </span>
                )}
              </div>

              <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight line-clamp-1">
                {item.tmdb?.title || item.parsed?.cleanTitle || item.fileName}
              </h2>

              {item.tmdb?.overview && (
                <p className="text-xs text-white/60 line-clamp-3 leading-relaxed">
                  {item.tmdb.overview}
                </p>
              )}

              {/* Animated Glowing Progress Bar & Speed Status */}
              <div className="pt-2 space-y-2">
                <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden relative">
                  <div className="h-full bg-gradient-to-r from-red-600 via-amber-500 to-emerald-400 rounded-full animate-pulse w-3/4 shadow-[0_0_12px_rgba(239,68,68,0.5)]" />
                </div>
                <div className="flex items-center justify-between text-[11px] text-white/60 font-mono">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
                    <span>{playbackStatus}</span>
                  </span>
                  <span className="text-white/90 font-semibold">{formatSpeed(transferSpeed)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mid-Stream Buffering Overlay (only after initial load has finished) */}
      {isBuffering && !isInitialLoading && !playbackError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-none z-30">
          <Loader2 className="w-10 h-10 text-white animate-spin drop-shadow-md" />
          <div className="mt-4 flex items-center space-x-2 px-4 py-1.5 rounded-full bg-black/60 border border-white/15 backdrop-blur-md text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono">{formatSpeed(transferSpeed)}</span>
            <span className="text-white/40">&bull;</span>
            <span className="text-white/80">{playbackStatus}</span>
          </div>
        </div>
      )}

      {/* Stall Recovery Overlay (>6s without chunk progress) */}
      {isStalled && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 p-4 rounded-2xl bg-[#1c1c1f]/95 border border-amber-500/30 shadow-2xl backdrop-blur-3xl flex items-center space-x-4 max-w-lg">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-white">Stream Buffering Stalled</p>
            <p className="text-white/60">GramJS chunk #{activeChunkIndex} is waiting on Telegram network.</p>
          </div>
          <button
            onClick={() => {
              if (videoRef.current) commitSeek(videoRef.current.currentTime);
            }}
            className="px-3 py-1.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Playback Error Modal */}
      {playbackError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-black/90 backdrop-blur-3xl z-50 text-center animate-fade-in">
          <div className="max-w-md w-full p-8 rounded-[32px] bg-[#161618]/95 border border-white/15 shadow-[0_25px_80px_rgba(0,0,0,0.9)] space-y-5">
            <div className="w-14 h-14 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center mx-auto border border-rose-500/20">
              <AlertCircle className="w-7 h-7" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-xl font-bold text-white tracking-tight">Playback Interrupted</h3>
              <p className="text-xs text-white/60 leading-relaxed">{playbackError}</p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => {
                  setPlaybackError(null);
                  setIsBuffering(true);
                  if (videoRef.current) commitSeek(videoRef.current.currentTime);
                }}
                className="px-8 py-3.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95 shadow-lg transition-all"
              >
                Retry Stream
              </button>
              <button
                onClick={onClose}
                className="px-6 py-3.5 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white/80 text-xs font-semibold transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Up Next Episode Card */}
      {countdownSeconds !== null && countdownSeconds > 0 && nextEpisode && (
        <div className="absolute bottom-32 right-8 z-40 p-5 rounded-3xl bg-[#16161a]/95 border border-white/15 shadow-2xl backdrop-blur-2xl flex items-center space-x-4 max-w-md animate-fade-in">
          <div className="flex-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Up Next</span>
            <h4 className="font-semibold text-sm text-white line-clamp-1 mt-0.5">
              {nextEpisode.tmdb?.title || nextEpisode.parsed.cleanTitle}
            </h4>
            <p className="text-xs text-white/50 mt-0.5">Auto-playing in {countdownSeconds}s</p>
          </div>
          <button
            onClick={() => onPlayNextEpisode && onPlayNextEpisode(nextEpisode)}
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95 shadow-md"
          >
            <FastForward className="w-4 h-4 fill-black" />
            <span>Play Now</span>
          </button>
        </div>
      )}

      {/* Complete Apple TV / TMPlayer Glass HUD */}
      <div
        className={`absolute inset-0 flex flex-col justify-between p-6 md:p-12 pointer-events-none transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Top Header Bar */}
        <div className="flex items-center justify-between pointer-events-auto">
          <div className="flex items-center space-x-4">
            <button
              onClick={onClose}
              className="flex items-center space-x-2 px-4 py-2 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-xs font-semibold backdrop-blur-2xl transition-all"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>
            <div>
              <h2 className="text-sm md:text-base font-bold text-white tracking-tight drop-shadow truncate max-w-md">
                {item.tmdb?.title || item.parsed.cleanTitle}
              </h2>
              {item.parsed.isSeries && (
                <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
                  Season {item.parsed.season || 1} &bull; Episode {item.parsed.episode || 1}
                </span>
              )}
            </div>
          </div>

          {/* Right Header Status Pill */}
          <div className="flex items-center space-x-2.5">
            <div className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-black/60 border border-white/15 backdrop-blur-2xl text-xs font-mono text-white/80">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{formatSpeed(transferSpeed)}</span>
            </div>
          </div>
        </div>

        {/* Center Transport Ripples / Controls (Tappable Area) */}
        <div
          onClick={togglePlayPause}
          className="flex-1 flex items-center justify-center cursor-pointer pointer-events-auto"
        />

        {/* Bottom Floating Glass HUD */}
        <div className="w-full max-w-4xl mx-auto pointer-events-auto space-y-3">
          <div className="p-5 md:p-6 rounded-[28px] bg-[#121214]/85 backdrop-blur-3xl border border-white/15 shadow-[0_20px_60px_rgba(0,0,0,0.85)] space-y-4">
            {/* Dual-Progress Scrubber */}
            <PlayerTimebar
              currentTime={currentTime}
              duration={duration}
              totalSize={item.fileSize}
              downloadedRanges={downloadedRanges}
              bookmarks={bookmarks}
              onSeek={(target) => commitSeek(target)}
            />

            {/* Controls Row */}
            <div className="flex items-center justify-between flex-wrap gap-4">
              {/* Left Controls */}
              <div className="flex items-center space-x-3">
                <button
                  onClick={togglePlayPause}
                  className="w-12 h-12 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black flex items-center justify-center shadow-lg transition-all"
                >
                  {isPlaying ? <Pause className="w-5 h-5 fill-black" /> : <Play className="w-5 h-5 fill-black ml-0.5" />}
                </button>

                <button
                  onClick={() => handleRelativeSeek(-10)}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 flex items-center justify-center text-white"
                  title="Rewind 10 seconds"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>

                <button
                  onClick={() => handleRelativeSeek(10)}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 flex items-center justify-center text-white"
                  title="Forward 10 seconds"
                >
                  <RotateCw className="w-4 h-4" />
                </button>

                {/* Timestamp */}
                <div className="text-xs font-mono font-medium text-white/80 pl-2">
                  <span>{formatTime(currentTime)}</span>
                  <span className="text-white/40 mx-1">/</span>
                  <span className="text-white/50">{formatTime(duration)}</span>
                </div>

                {/* Inline Volume & Mute Control */}
                <div className="hidden sm:flex items-center space-x-1.5 pl-3 border-l border-white/10">
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className="p-1.5 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors"
                    title={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX className="w-4 h-4 text-rose-400" />
                    ) : volume < 0.5 ? (
                      <Volume1 className="w-4 h-4" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setVolume(v);
                      if (isMuted && v > 0) setIsMuted(false);
                    }}
                    className="w-16 h-1 bg-white/20 hover:bg-white/40 accent-white rounded-lg appearance-none cursor-pointer transition-all"
                  />
                </div>
              </div>

              {/* Right Controls */}
              <div className="flex items-center space-x-2">
                {/* Subtitles & Audio Selector */}
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowSubMenu(!showSubMenu);
                      setShowSpeedMenu(false);
                    }}
                    className={`p-2.5 rounded-full border transition-all active:scale-95 ${
                      activeSubtitleId !== 'off'
                        ? 'bg-white text-black border-white font-bold'
                        : 'bg-white/10 text-white hover:bg-white/20 border-white/10'
                    }`}
                    title="Subtitles & Audio"
                  >
                    <Subtitles className="w-4 h-4" />
                  </button>

                  {showSubMenu && (
                    <div className="absolute bottom-12 right-0 w-48 p-2 rounded-2xl bg-[#18181c]/95 border border-white/15 shadow-2xl backdrop-blur-3xl space-y-1 z-40">
                      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Subtitles
                      </div>
                      <button
                        onClick={() => {
                          setActiveSubtitleId('off');
                          setShowSubMenu(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                          activeSubtitleId === 'off' ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
                        }`}
                      >
                        <span>Off</span>
                        {activeSubtitleId === 'off' && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                      </button>
                      {subtitles.map((sub) => (
                        <button
                          key={sub.id}
                          onClick={() => {
                            setActiveSubtitleId(sub.id);
                            setShowSubMenu(false);
                          }}
                          className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                            activeSubtitleId === sub.id ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
                          }`}
                        >
                          <span className="truncate">{sub.label}</span>
                          {activeSubtitleId === sub.id && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Night Mode Audio Toggle */}
                <button
                  onClick={handleNightModeToggle}
                  className={`p-2.5 rounded-full border transition-all active:scale-95 ${
                    nightMode
                      ? 'bg-amber-400 text-black border-amber-400 font-bold shadow-md'
                      : 'bg-white/10 text-white hover:bg-white/20 border-white/10'
                  }`}
                  title={nightMode ? 'Night Mode Audio Active (Compressed Dynamic Range)' : 'Enable Night Mode Audio'}
                >
                  <Moon className="w-4 h-4" />
                </button>

                {/* Aspect Ratio Toggle */}
                <button
                  onClick={cycleAspectRatio}
                  className="px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-xs font-semibold text-white/80 hover:text-white uppercase tracking-wider"
                  title={`Picture Aspect Ratio: ${aspectRatio}`}
                >
                  {aspectRatio}
                </button>

                {/* A-B Loop Button */}
                <button
                  onClick={handleABLoop}
                  className={`flex items-center space-x-1 px-3 py-1.5 rounded-full border text-xs font-semibold transition-all ${
                    loopA !== null
                      ? 'bg-amber-400 text-black border-amber-400 shadow-md'
                      : 'bg-white/10 text-white/80 hover:bg-white/20 border-white/10'
                  }`}
                  title="A-B Repeat Loop"
                >
                  <Repeat className="w-3.5 h-3.5" />
                  <span>{loopA === null ? 'A-B' : loopB === null ? 'Set B' : 'Looping'}</span>
                </button>

                {/* Bookmark Button */}
                <button
                  onClick={handleAddBookmark}
                  className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-white active:scale-95"
                  title="Add Bookmark at Current Timestamp"
                >
                  <Bookmark className="w-4 h-4" />
                </button>

                {/* Playback Speed Menu */}
                <div className="relative">
                  <button
                    onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                    className="flex items-center space-x-1 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-xs font-semibold text-white"
                  >
                    <Gauge className="w-3.5 h-3.5" />
                    <span>{playbackSpeed}x</span>
                  </button>

                  {showSpeedMenu && (
                    <div className="absolute bottom-12 right-0 w-32 p-1.5 rounded-2xl bg-[#18181c]/95 border border-white/15 shadow-2xl backdrop-blur-3xl space-y-0.5 z-40">
                      {[0.5, 0.75, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0].map((spd) => (
                        <button
                          key={spd}
                          onClick={() => handleSpeedSelect(spd)}
                          className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                            playbackSpeed === spd ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
                          }`}
                        >
                          <span>{spd}x</span>
                          {playbackSpeed === spd && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Fullscreen Button */}
                <button
                  onClick={toggleFullscreen}
                  className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-white active:scale-95"
                >
                  {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
