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
  Upload,
  Volume,
  Undo2,
} from 'lucide-react';
import type { ChannelVideoItem, SubtitleTrack } from '../types';
import { saveWatchProgress } from '../services/db';
import { streamDb } from '../db/streamDb';
import { resolveCachedDocument, fetchSubtitleContent, convertSrtToVtt } from '../services/telegram';
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<string>('Connecting stream...');

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

  // Video Options
  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('fit');
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string>('off');
  const [audioTracks, setAudioTracks] = useState<Array<{ id: string; label: string; language?: string }>>([]);
  const [activeAudioTrackId, setActiveAudioTrackId] = useState<string>('0');

  // Popup Menus
  const [showSubMenu, setShowSubMenu] = useState<boolean>(false);
  const [showAudioMenu, setShowAudioMenu] = useState<boolean>(false);
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

      // Load saved series playback speed
      try {
        const savedProg = await streamDb.playbackProgress.get(streamId);
        if (savedProg && isMounted && savedProg.playbackSpeed) {
          setPlaybackSpeed(savedProg.playbackSpeed);
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
  // Subtitle Loader (Telegram SRT + User Upload)
  // ────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    if (item.subtitleMessageId) {
      fetchSubtitleContent(item.channelId, item.subtitleMessageId).then((vtt) => {
        if (!isMounted || !vtt) return;
        const blob = new Blob([vtt], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        const subTrack: SubtitleTrack = {
          id: `tg_sub_${item.subtitleMessageId}`,
          label: 'Telegram Subtitle',
          language: 'en',
          src: url,
        };
        setSubtitles([subTrack]);
        setActiveSubtitleId(subTrack.id);
      });
    } else {
      setSubtitles([]);
      setActiveSubtitleId('off');
    }
    return () => {
      isMounted = false;
    };
  }, [item.channelId, item.subtitleMessageId]);

  // Synchronize Subtitle Track to HTML5 Video
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const textTracks = v.textTracks;
    if (textTracks) {
      for (let i = 0; i < textTracks.length; i++) {
        const t = textTracks[i];
        if (activeSubtitleId === 'off') {
          t.mode = 'disabled';
        } else {
          t.mode = t.id === activeSubtitleId ? 'showing' : 'disabled';
        }
      }
    }
  }, [activeSubtitleId, subtitles]);

  // Handle Local Subtitle File Upload (.srt / .vtt)
  const handleSubtitleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      let text = event.target?.result as string;
      if (!text) return;
      if (!text.startsWith('WEBVTT')) {
        text = convertSrtToVtt(text);
      }
      const blob = new Blob([text], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      const newTrack: SubtitleTrack = {
        id: `custom_${Date.now()}`,
        label: file.name.replace(/\.[^/.]+$/, ''),
        language: 'und',
        src: url,
      };
      setSubtitles((prev) => [...prev, newTrack]);
      setActiveSubtitleId(newTrack.id);
      setShowSubMenu(false);
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  // Detect Audio Tracks on Video Element
  const checkAudioTracks = useCallback(() => {
    const v = videoRef.current as any;
    if (!v) return;
    if (v.audioTracks && v.audioTracks.length > 0) {
      const list = [];
      for (let i = 0; i < v.audioTracks.length; i++) {
        const track = v.audioTracks[i];
        list.push({
          id: i.toString(),
          label: track.label || track.language || `Track ${i + 1}`,
          language: track.language,
        });
        if (track.enabled) {
          setActiveAudioTrackId(i.toString());
        }
      }
      setAudioTracks(list);
    }
  }, []);

  const handleSelectAudioTrack = (trackId: string) => {
    setActiveAudioTrackId(trackId);
    const v = videoRef.current as any;
    if (v?.audioTracks) {
      for (let i = 0; i < v.audioTracks.length; i++) {
        v.audioTracks[i].enabled = i.toString() === trackId;
      }
    }
    setShowAudioMenu(false);
  };

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

        await streamDb.playbackProgress.put({
          streamId,
          chatId: item.channelId,
          positionSec: cTime,
          durationSec: dur,
          completed: dur > 0 && cTime / dur >= 0.9,
          playbackSpeed,
          bookmarks: [],
          updatedAt: Date.now(),
        });
      }
    }, 5000);

    return () => clearInterval(saveInterval);
  }, [item, duration, streamId, playbackSpeed]);

  // Synchronize Volume & Mute to Video Element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // ────────────────────────────────────────────
  // Controls HUD Auto-Hide Loop (3.5s)
  // ────────────────────────────────────────────
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
        setShowSubMenu(false);
        setShowAudioMenu(false);
        setShowSpeedMenu(false);
      }, 3500);
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

      // Ripple indicator
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
  // Keyboard Shortcuts
  // ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || (e as any).keyCode === 461) {
        e.preventDefault();
        if (showControls) {
          setShowControls(false);
          setShowSubMenu(false);
          setShowAudioMenu(false);
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

  // Next Episode Countdown Timer
  useEffect(() => {
    if (countdownSeconds === null) return;
    if (countdownSeconds <= 0) {
      if (nextEpisode && onPlayNextEpisode) {
        onPlayNextEpisode(nextEpisode);
      }
      setCountdownSeconds(null);
      return;
    }
    const timer = setTimeout(() => {
      setCountdownSeconds((s) => (s !== null ? s - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdownSeconds, nextEpisode, onPlayNextEpisode]);

  // Transport Controls
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

    await streamDb.playbackProgress.put({
      streamId,
      chatId: item.channelId,
      positionSec: currentTime,
      durationSec: duration,
      completed: duration > 0 && currentTime / duration >= 0.9,
      playbackSpeed: spd,
      bookmarks: [],
      updatedAt: Date.now(),
    });
  };

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
      {/* Video Element - Clean, zero blur */}
      <video
        ref={videoRef}
        className={getVideoAspectClass()}
        playsInline
        onLoadedData={checkAudioTracks}
        onLoadedMetadata={() => {
          checkAudioTracks();
          if (videoRef.current && videoRef.current.duration) setDuration(videoRef.current.duration);
        }}
        onTimeUpdate={() => {
          if (videoRef.current) {
            const ct = videoRef.current.currentTime;
            setCurrentTime(ct);
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
        onCanPlay={() => {
          setIsBuffering(false);
          setPlaybackStatus('');
        }}
        onPlaying={() => {
          setIsBuffering(false);
          setIsPlaying(true);
          setPlaybackStatus('');
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          const autoPlay = localStorage.getItem('streamup_autoplay_next') !== 'false';
          if (nextEpisode && onPlayNextEpisode) {
            if (autoPlay) {
              onPlayNextEpisode(nextEpisode);
            } else {
              setCountdownSeconds(10);
            }
          }
        }}
        onError={() => {
          const err = videoRef.current?.error;
          console.warn('Video element error event caught:', err?.code, err?.message);
        }}
      >
        {/* Subtitle Tracks */}
        {subtitles.map((sub) => (
          <track
            key={sub.id}
            id={sub.id}
            kind="subtitles"
            src={sub.src}
            label={sub.label}
            srcLang={sub.language}
            default={activeSubtitleId === sub.id}
          />
        ))}
      </video>

      {/* Hidden File Input for Subtitle Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt"
        onChange={handleSubtitleFileUpload}
        className="hidden"
      />

      {/* Subtle Corner Loading & Transfer Speed Badge (Left corner, no screen blur) */}
      {isBuffering && !playbackError && (
        <div
          className={`absolute z-40 flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-black/75 border border-white/15 backdrop-blur-md text-xs font-mono text-white shadow-xl animate-fade-in pointer-events-none transition-all duration-300 ${
            showControls ? 'top-20 left-6 md:left-8' : 'top-6 left-6 md:left-8'
          }`}
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
          <span>{playbackStatus || 'Buffering'}</span>
          <span className="text-white/30">&bull;</span>
          <span className="text-emerald-400 font-semibold">{formatSpeed(transferSpeed)}</span>
        </div>
      )}

      {/* Center Initial Spinner (if first load, no blur) */}
      {currentTime === 0 && isBuffering && !playbackError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
          <Loader2 className="w-12 h-12 text-white animate-spin drop-shadow-lg" />
        </div>
      )}

      {/* Ripple Seek Indicator (+10s / -10s) */}
      {seekRippleText && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-6 py-3 rounded-2xl bg-black/80 backdrop-blur-2xl border border-white/20 text-2xl font-bold tracking-tight shadow-2xl pointer-events-none animate-scale-up">
          {seekRippleText}
        </div>
      )}

      {/* Jump-Back Pill (seeking > 30s away) */}
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

      {/* Stall Recovery Overlay (>6s without chunk progress) */}
      {isStalled && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 p-4 rounded-2xl bg-[#1c1c1f]/95 border border-amber-500/30 shadow-2xl backdrop-blur-3xl flex items-center space-x-4 max-w-lg">
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

      {/* Up Next Countdown Toast */}
      {countdownSeconds !== null && countdownSeconds > 0 && nextEpisode && (
        <div className="absolute bottom-28 right-8 z-40 p-4 rounded-2xl bg-[#16161a]/95 border border-white/15 shadow-2xl backdrop-blur-2xl flex items-center space-x-4 max-w-sm animate-fade-in">
          <div className="flex-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Up Next</span>
            <h4 className="font-semibold text-xs text-white line-clamp-1 mt-0.5">
              {nextEpisode.tmdb?.title || nextEpisode.parsed.cleanTitle}
            </h4>
            <p className="text-[11px] text-white/50 mt-0.5">Playing in {countdownSeconds}s</p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onPlayNextEpisode && onPlayNextEpisode(nextEpisode)}
              className="flex items-center space-x-1 px-3 py-1.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95 shadow-md"
            >
              <FastForward className="w-3.5 h-3.5 fill-black" />
              <span>Play</span>
            </button>
            <button
              onClick={() => setCountdownSeconds(null)}
              className="px-2.5 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white/70 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Common Minimal Video Player HUD */}
      <div
        className={`absolute inset-0 flex flex-col justify-between p-4 md:p-8 pointer-events-none transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Top Header Bar */}
        <div className="flex items-center justify-between pointer-events-auto bg-gradient-to-b from-black/70 to-transparent p-4 -m-4 md:-m-8 md:p-8">
          <div className="flex items-center space-x-3.5 min-w-0">
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex items-center justify-center backdrop-blur-xl transition-all shadow-md"
              title="Close Player"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h2 className="text-sm md:text-base font-bold text-white tracking-tight drop-shadow truncate max-w-sm md:max-w-xl">
                {item.tmdb?.title || item.parsed.cleanTitle}
              </h2>
              {item.parsed.isSeries && (
                <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider block">
                  Season {item.parsed.season || 1} &bull; Episode {item.parsed.episode || 1}
                </span>
              )}
            </div>
          </div>

          {/* Right Header Status */}
          <div className="flex items-center space-x-2">
            {/* Live Streaming Speed Badge */}
            <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-black/60 border border-white/15 backdrop-blur-xl text-xs font-mono text-white/80 shadow-md">
              <Wifi className="w-3 h-3 text-emerald-400" />
              <span>{formatSpeed(transferSpeed)}</span>
            </div>

            {/* Aspect Ratio Button */}
            <button
              onClick={cycleAspectRatio}
              className="px-3 py-1 rounded-full bg-black/60 hover:bg-white/20 border border-white/15 text-xs font-semibold text-white/80 hover:text-white uppercase tracking-wider transition-all"
              title={`Aspect Ratio: ${aspectRatio}`}
            >
              {aspectRatio}
            </button>
          </div>
        </div>

        {/* Center Quick Transport (Tap to Play/Pause, Skip Buttons) */}
        <div
          onClick={togglePlayPause}
          className="flex-1 flex items-center justify-center cursor-pointer pointer-events-auto"
        >
          <div className="flex items-center space-x-6 md:space-x-10 pointer-events-auto">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRelativeSeek(-10);
              }}
              className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex flex-col items-center justify-center transition-all backdrop-blur-md group"
              title="Skip 10s Backward"
            >
              <RotateCcw className="w-5 h-5 md:w-6 md:h-6" />
              <span className="text-[9px] font-bold mt-0.5 text-white/80">10</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                togglePlayPause();
              }}
              className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black flex items-center justify-center shadow-2xl transition-all"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-8 h-8 fill-black" />
              ) : (
                <Play className="w-8 h-8 fill-black ml-1" />
              )}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRelativeSeek(10);
              }}
              className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex flex-col items-center justify-center transition-all backdrop-blur-md group"
              title="Skip 10s Forward"
            >
              <RotateCw className="w-5 h-5 md:w-6 md:h-6" />
              <span className="text-[9px] font-bold mt-0.5 text-white/80">10</span>
            </button>
          </div>
        </div>

        {/* Bottom Floating Minimal Controls Bar */}
        <div className="w-full max-w-4xl mx-auto pointer-events-auto space-y-2 pb-2">
          <div className="p-4 md:p-5 rounded-3xl bg-[#121214]/90 backdrop-blur-2xl border border-white/15 shadow-[0_20px_50px_rgba(0,0,0,0.85)] space-y-3">
            {/* Scrubber Timebar */}
            <PlayerTimebar
              currentTime={currentTime}
              duration={duration}
              totalSize={item.fileSize}
              downloadedRanges={downloadedRanges}
              onSeek={(target) => commitSeek(target)}
            />

            {/* Controls Button Row */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              {/* Left Group */}
              <div className="flex items-center space-x-2.5">
                {/* Play / Pause */}
                <button
                  onClick={togglePlayPause}
                  className="w-9 h-9 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black flex items-center justify-center shadow-md transition-all"
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4 fill-black" />
                  ) : (
                    <Play className="w-4 h-4 fill-black ml-0.5" />
                  )}
                </button>

                {/* 10s Backward */}
                <button
                  onClick={() => handleRelativeSeek(-10)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 flex items-center justify-center text-white"
                  title="Rewind 10 seconds"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>

                {/* 10s Forward */}
                <button
                  onClick={() => handleRelativeSeek(10)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 flex items-center justify-center text-white"
                  title="Forward 10 seconds"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>

                {/* Next Episode Button */}
                {nextEpisode && onPlayNextEpisode && (
                  <button
                    onClick={() => onPlayNextEpisode(nextEpisode)}
                    className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 flex items-center justify-center text-white"
                    title={`Next: ${nextEpisode.tmdb?.title || nextEpisode.parsed.cleanTitle}`}
                  >
                    <FastForward className="w-3.5 h-3.5 fill-white" />
                  </button>
                )}

                {/* Inline Volume & Mute */}
                <div className="flex items-center space-x-1.5 pl-2 border-l border-white/10">
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className="p-1 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors"
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
                    className="w-14 h-1 bg-white/20 hover:bg-white/40 accent-white rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* Timestamp */}
                <div className="text-xs font-mono font-medium text-white/80 pl-2">
                  <span>{formatTime(currentTime)}</span>
                  <span className="text-white/40 mx-1">/</span>
                  <span className="text-white/50">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Right Group */}
              <div className="flex items-center space-x-2">
                {/* Audio Tracks Menu */}
                {audioTracks.length > 1 && (
                  <div className="relative">
                    <button
                      onClick={() => {
                        setShowAudioMenu(!showAudioMenu);
                        setShowSubMenu(false);
                        setShowSpeedMenu(false);
                      }}
                      className={`p-2 rounded-full border transition-all active:scale-95 ${
                        showAudioMenu
                          ? 'bg-white text-black border-white font-bold'
                          : 'bg-white/10 text-white hover:bg-white/20 border-white/10'
                      }`}
                      title="Audio Tracks"
                    >
                      <Volume className="w-3.5 h-3.5" />
                    </button>

                    {showAudioMenu && (
                      <div className="absolute bottom-11 right-0 w-44 p-2 rounded-2xl bg-[#18181c]/95 border border-white/15 shadow-2xl backdrop-blur-2xl space-y-1 z-40">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white/40">
                          Audio Tracks
                        </div>
                        {audioTracks.map((trk) => (
                          <button
                            key={trk.id}
                            onClick={() => handleSelectAudioTrack(trk.id)}
                            className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                              activeAudioTrackId === trk.id
                                ? 'bg-white text-black'
                                : 'text-white/80 hover:bg-white/10'
                            }`}
                          >
                            <span className="truncate">{trk.label}</span>
                            {activeAudioTrackId === trk.id && (
                              <Check className="w-3.5 h-3.5 stroke-[3]" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Subtitles Menu */}
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowSubMenu(!showSubMenu);
                      setShowAudioMenu(false);
                      setShowSpeedMenu(false);
                    }}
                    className={`p-2 rounded-full border transition-all active:scale-95 ${
                      activeSubtitleId !== 'off'
                        ? 'bg-white text-black border-white font-bold'
                        : 'bg-white/10 text-white hover:bg-white/20 border-white/10'
                    }`}
                    title="Subtitles"
                  >
                    <Subtitles className="w-3.5 h-3.5" />
                  </button>

                  {showSubMenu && (
                    <div className="absolute bottom-11 right-0 w-48 p-2 rounded-2xl bg-[#18181c]/95 border border-white/15 shadow-2xl backdrop-blur-2xl space-y-1 z-40">
                      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Subtitles
                      </div>
                      <button
                        onClick={() => {
                          setActiveSubtitleId('off');
                          setShowSubMenu(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                          activeSubtitleId === 'off'
                            ? 'bg-white text-black'
                            : 'text-white/80 hover:bg-white/10'
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
                            activeSubtitleId === sub.id
                              ? 'bg-white text-black'
                              : 'text-white/80 hover:bg-white/10'
                          }`}
                        >
                          <span className="truncate">{sub.label}</span>
                          {activeSubtitleId === sub.id && (
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                          )}
                        </button>
                      ))}
                      <div className="pt-1 border-t border-white/10">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="w-full text-left px-3 py-1.5 rounded-xl text-xs font-medium text-white/70 hover:text-white hover:bg-white/10 flex items-center space-x-2"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          <span>Load subtitle file...</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Playback Speed Menu */}
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowSpeedMenu(!showSpeedMenu);
                      setShowSubMenu(false);
                      setShowAudioMenu(false);
                    }}
                    className="flex items-center space-x-1 px-2.5 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-xs font-semibold text-white"
                    title="Playback Speed"
                  >
                    <Gauge className="w-3 h-3" />
                    <span>{playbackSpeed}x</span>
                  </button>

                  {showSpeedMenu && (
                    <div className="absolute bottom-11 right-0 w-28 p-1.5 rounded-2xl bg-[#18181c]/95 border border-white/15 shadow-2xl backdrop-blur-2xl space-y-0.5 z-40">
                      {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((spd) => (
                        <button
                          key={spd}
                          onClick={() => handleSpeedSelect(spd)}
                          className={`w-full text-left px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-between ${
                            playbackSpeed === spd
                              ? 'bg-white text-black'
                              : 'text-white/80 hover:bg-white/10'
                          }`}
                        >
                          <span>{spd}x</span>
                          {playbackSpeed === spd && (
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Fullscreen Toggle */}
                <button
                  onClick={toggleFullscreen}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-white active:scale-95"
                  title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
