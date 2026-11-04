// src/features/player/components/TMWebPlayer.tsx
// TMPlayer-inspired Web Streaming Player (Web-only, Range-based, Seek-aware, Resume-aware)

import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
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
  Undo2,
  PlayCircle,
} from 'lucide-react';
import type { ChannelVideoItem, SubtitleTrack } from '../../../types';
import { usePlayerSession } from '../hooks/usePlayerSession';
import { fetchSubtitleContent, convertSrtToVtt } from '../../../services/telegram';
import { getLanguageDisplayName } from '../../../services/remuxer/ebml';
import { PlayerTimebar } from '../../../components/PlayerTimebar';
import type { ByteRange } from '../../../services/windowPlanner';
import { PlayerErrorOverlay } from './PlayerErrorOverlay';

export interface TMWebPlayerProps {
  item: ChannelVideoItem;
  initialTime?: number;
  onClose: () => void;
  nextEpisode?: ChannelVideoItem | null;
  onPlayNextEpisode?: (next: ChannelVideoItem) => void;
}

type AspectRatioMode = 'fit' | 'fill' | 'stretch' | '16:9' | '4:3';

export const TMWebPlayer: React.FC<TMWebPlayerProps> = ({
  item,
  initialTime = 0,
  onClose,
  nextEpisode,
  onPlayNextEpisode,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const fileId = `${item.channelId}_${item.messageId}`;
  const fileName = item.fileName || item.parsed?.originalFileName || 'video.mp4';
  const mimeType = item.mimeType || 'video/mp4';
  const fileSize = item.fileSize || 0;

  // TMPlayer Session Hook (handles range streaming, resume state, auto-save, seeking)
  const { videoRef, state, actions, mediaProps } = usePlayerSession({
    fileId,
    initialTime,
    fileName,
    mimeType,
    fileSize,
    duration: item.duration || 0,
    autoPlay: true,
  });

  const {
    isPlaying,
    currentTime,
    duration,
    isBuffering,
    playbackStatus,
    transferSpeed,
    isStalled,
    playbackError,
    hasResumePoint,
    resumeSeconds,
    embeddedSubtitles,
    currentSubtitleText,
  } = state;

  // Local UI State
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('fit');

  // Popup Menus
  const [showSubMenu, setShowSubMenu] = useState<boolean>(false);
  const [showAudioMenu, setShowAudioMenu] = useState<boolean>(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState<boolean>(false);
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [selectedQuality, setSelectedQuality] = useState<string>('Auto');

  // Subtitles & Audio Tracks
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string>('off');
  const [audioTracks, setAudioTracks] = useState<Array<{ id: string; label: string; language?: string }>>([]);
  const [activeAudioTrackId, setActiveAudioTrackId] = useState<string>('0');

  // Debounced Seek Ripple
  const [seekRippleText, setSeekRippleText] = useState<string | null>(null);
  const rippleTimerRef = useRef<any>(null);
  const controlsTimeoutRef = useRef<any>(null);

  // Countdown Toast for Next Episode
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);

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
  // Controls Auto-Hide
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
  // Subtitles Loader & Handler
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
      });
    } else {
      setSubtitles([]);
    }
    return () => {
      isMounted = false;
    };
  }, [item.channelId, item.subtitleMessageId]);

  // Combine external telegram subtitles and container embedded subtitles
  const availableSubtitles = useMemo(() => {
    const list: Array<{ id: string; label: string; trackNumber?: number; src?: string }> = [];
    if (subtitles.length > 0) {
      list.push(...subtitles);
    }
    if (embeddedSubtitles && embeddedSubtitles.length > 0) {
      embeddedSubtitles.forEach((s) => {
        const langName = getLanguageDisplayName(s.language, s.name);
        list.push({
          id: `mkv_sub_${s.trackNumber}`,
          label: s.name ? `${s.name} (${langName})` : langName,
          trackNumber: s.trackNumber,
        });
      });
    }
    return list;
  }, [subtitles, embeddedSubtitles]);

  const handleSelectSubtitle = useCallback(
    (subId: string, trackNumber?: number) => {
      setActiveSubtitleId(subId);
      setShowSubMenu(false);
      if (subId === 'off') {
        actions.selectSubtitleTrack(null);
      } else if (typeof trackNumber === 'number') {
        actions.selectSubtitleTrack(trackNumber);
      } else {
        // External telegram subtitle track
        actions.selectSubtitleTrack(null);
      }
    },
    [actions]
  );

  // Sync Subtitle Track to HTML5 Video
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
  }, [activeSubtitleId, subtitles, videoRef]);

  // Sync Audio Tracks
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
  }, [videoRef]);

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
  // Relative Seek with Ripple Animation
  // ────────────────────────────────────────────
  const triggerRelativeSeek = useCallback(
    (delta: number) => {
      actions.skipRelative(delta);
      const sign = delta > 0 ? `+${delta}s` : `${delta}s`;
      setSeekRippleText(sign);
      if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
      rippleTimerRef.current = setTimeout(() => setSeekRippleText(null), 800);
      resetControlsTimeout();
    },
    [actions, resetControlsTimeout]
  );

  // ────────────────────────────────────────────
  // Keyboard & TV Remote Shortcuts
  // ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const code = e.keyCode || e.which;

      if (e.key === 'Escape' || e.key === 'Backspace' || code === 461) {
        e.preventDefault();
        if (showControls) {
          setShowControls(false);
          setShowSubMenu(false);
          setShowAudioMenu(false);
          setShowSpeedMenu(false);
          setShowQualityMenu(false);
        } else {
          onClose();
        }
      } else if (code === 415 || e.key === 'MediaPlay') {
        e.preventDefault();
        actions.play();
        resetControlsTimeout();
      } else if (code === 19 || e.key === 'MediaPause') {
        e.preventDefault();
        actions.pause();
        resetControlsTimeout();
      } else if (code === 413 || e.key === 'MediaStop') {
        e.preventDefault();
        actions.pause();
        onClose();
      } else if (code === 417 || e.key === 'MediaFastForward') {
        e.preventDefault();
        triggerRelativeSeek(30);
      } else if (code === 412 || e.key === 'MediaRewind') {
        e.preventDefault();
        triggerRelativeSeek(-30);
      } else if (e.key === ' ' || e.key === 'k' || e.key === 'Enter') {
        e.preventDefault();
        actions.togglePlay();
        resetControlsTimeout();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        e.preventDefault();
        triggerRelativeSeek(-10);
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        e.preventDefault();
        triggerRelativeSeek(10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setVolume((prev) => Math.min(1, prev + 0.1));
        setIsMuted(false);
        resetControlsTimeout();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setVolume((prev) => Math.max(0, prev - 0.1));
        resetControlsTimeout();
      } else if (e.key === 'm') {
        e.preventDefault();
        setIsMuted((prev) => !prev);
        resetControlsTimeout();
      } else if (e.key === 'f') {
        e.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showControls, actions, triggerRelativeSeek, resetControlsTimeout, onClose]);

  // Sync Volume
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted, videoRef]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleSpeedSelect = (spd: number) => {
    setPlaybackSpeed(spd);
    if (videoRef.current) videoRef.current.playbackRate = spd;
    setShowSpeedMenu(false);
  };

  const cycleAspectRatio = () => {
    const modes: AspectRatioMode[] = ['fit', 'fill', 'stretch', '16:9', '4:3'];
    const nextIdx = (modes.indexOf(aspectRatio) + 1) % modes.length;
    setAspectRatio(modes[nextIdx]);
  };

  const getVideoStyle = (): React.CSSProperties => {
    switch (aspectRatio) {
      case 'fill':
        return { objectFit: 'cover' };
      case 'stretch':
        return { objectFit: 'fill' };
      case '16:9':
        return { aspectRatio: '16/9', objectFit: 'contain' };
      case '4:3':
        return { aspectRatio: '4/3', objectFit: 'contain' };
      case 'fit':
      default:
        return { objectFit: 'contain' };
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={resetControlsTimeout}
      onClick={resetControlsTimeout}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center select-none overflow-hidden font-sans"
    >
      {/* HTML5 Video Surface */}
      <video
        ref={videoRef}
        playsInline
        className="w-full h-full cursor-pointer transition-all duration-300"
        style={getVideoStyle()}
        onClick={actions.togglePlay}
        onDoubleClick={toggleFullscreen}
        onLoadedData={checkAudioTracks}
        {...mediaProps}
      >
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

      {/* Container Embedded / Active Subtitle Overlay */}
      {activeSubtitleId !== 'off' && currentSubtitleText && (
        <div className="absolute bottom-16 sm:bottom-20 left-1/2 -translate-x-1/2 max-w-[85%] text-center pointer-events-none z-30 select-none animate-fade-in">
          <span
            className="inline-block text-white font-semibold text-base sm:text-lg md:text-2xl tracking-wide whitespace-pre-line leading-relaxed"
            style={{
              textShadow:
                '0 0 4px #000, 0 1px 2px #000, 0 2px 4px #000, 0 3px 6px #000, 0 0 10px rgba(0,0,0,0.85)',
            }}
          >
            {currentSubtitleText}
          </span>
        </div>
      )}

      {/* Subtle Top-Left Corner Loading & Speed Badge (TMPlayer style) */}
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

      {/* Resume Banner if there is saved progress */}
      {hasResumePoint && resumeSeconds > 5 && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 p-4 rounded-2xl bg-[#1c1c1f]/95 border border-cyan-500/30 shadow-2xl backdrop-blur-3xl flex items-center space-x-4 max-w-md animate-fade-in">
          <PlayCircle className="w-5 h-5 text-cyan-400 shrink-0" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-white">Resume Playback?</p>
            <p className="text-white/60">Continue from {formatTime(resumeSeconds)}</p>
          </div>
          <button
            onClick={actions.resume}
            className="px-3.5 py-1.5 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs transition-all shadow-md active:scale-95"
          >
            Resume
          </button>
        </div>
      )}

      {/* Ripple Seek Indicator (+10s / -10s) */}
      {seekRippleText && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-6 py-3 rounded-2xl bg-black/80 backdrop-blur-2xl border border-white/20 text-2xl font-bold tracking-tight shadow-2xl pointer-events-none animate-scale-up">
          {seekRippleText}
        </div>
      )}

      {/* Stall Alert Overlay */}
      {isStalled && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 p-4 rounded-2xl bg-[#1c1c1f]/95 border border-amber-500/30 shadow-2xl backdrop-blur-3xl flex items-center space-x-4 max-w-lg">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-white">Stream Buffering Stalled</p>
            <p className="text-white/60">Waiting on Telegram network connection...</p>
          </div>
          <button
            onClick={() => actions.seekTo(currentTime)}
            className="px-3 py-1.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95"
          >
            Retry
          </button>
        </div>
      )}

      {/* Rich Player Error State UI Overlay */}
      {playbackError && (
        <PlayerErrorOverlay
          media={item}
          error={playbackError}
          onRetry={() => actions.retry(currentTime)}
          onClose={onClose}
          nextEpisode={nextEpisode}
          onPlayNext={
            nextEpisode && onPlayNextEpisode
              ? () => onPlayNextEpisode(nextEpisode)
              : undefined
          }
        />
      )}

      {/* Minimal Web Player HUD */}
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
            <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-black/60 border border-white/15 backdrop-blur-xl text-xs font-mono text-white/80 shadow-md">
              <Wifi className="w-3 h-3 text-emerald-400" />
              <span>{formatSpeed(transferSpeed)}</span>
            </div>

            <button
              onClick={cycleAspectRatio}
              className="px-3 py-1 rounded-full bg-black/60 hover:bg-white/20 border border-white/15 text-xs font-semibold text-white/80 hover:text-white uppercase tracking-wider transition-all"
              title={`Aspect Ratio: ${aspectRatio}`}
            >
              {aspectRatio}
            </button>
          </div>
        </div>

        {/* Center Quick Transport (Tap Overlay) */}
        <div
          onClick={actions.togglePlay}
          className="flex-1 flex items-center justify-center pointer-events-auto cursor-pointer"
        >
          {showControls && (
            <div
              className="flex items-center space-x-6 bg-black/40 backdrop-blur-md px-6 py-4 rounded-full border border-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => triggerRelativeSeek(-10)}
                className="w-11 h-11 rounded-full hover:bg-white/20 active:scale-90 flex items-center justify-center text-white/80 hover:text-white transition-all"
                title="-10 Seconds"
              >
                <RotateCcw className="w-5 h-5" />
              </button>
              <button
                onClick={actions.togglePlay}
                className="w-14 h-14 rounded-full bg-white text-black hover:scale-105 active:scale-95 flex items-center justify-center transition-all shadow-xl"
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-6 h-6 fill-black" /> : <Play className="w-6 h-6 fill-black ml-0.5" />}
              </button>
              <button
                onClick={() => triggerRelativeSeek(10)}
                className="w-11 h-11 rounded-full hover:bg-white/20 active:scale-90 flex items-center justify-center text-white/80 hover:text-white transition-all"
                title="+10 Seconds"
              >
                <RotateCw className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>

        {/* Bottom Control Bar */}
        <div className="pointer-events-auto bg-gradient-to-t from-black/85 via-black/60 to-transparent p-4 -m-4 md:-m-8 md:p-8 space-y-3">
          {/* Scrubber / Timebar */}
          <PlayerTimebar
            currentTime={currentTime}
            duration={duration}
            totalSize={fileSize}
            bufferedRanges={state.bufferedRanges}
            onSeek={(t) => actions.seekTo(t)}
          />

          {/* Controls Row */}
          <div className="flex items-center justify-between gap-4">
            {/* Left Transport */}
            <div className="flex items-center space-x-2 sm:space-x-3">
              <button
                onClick={actions.togglePlay}
                className="w-9 h-9 rounded-full bg-white text-black hover:bg-white/90 active:scale-95 flex items-center justify-center transition-all shadow-md"
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-black" /> : <Play className="w-4 h-4 fill-black ml-0.5" />}
              </button>

              <button
                onClick={() => triggerRelativeSeek(-10)}
                className="w-8 h-8 rounded-full hover:bg-white/15 active:scale-90 flex items-center justify-center text-white/80 hover:text-white transition-all"
                title="-10s"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerRelativeSeek(10)}
                className="w-8 h-8 rounded-full hover:bg-white/15 active:scale-90 flex items-center justify-center text-white/80 hover:text-white transition-all"
                title="+10s"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              {nextEpisode && onPlayNextEpisode && (
                <button
                  onClick={() => onPlayNextEpisode(nextEpisode)}
                  className="w-8 h-8 rounded-full hover:bg-white/15 active:scale-90 flex items-center justify-center text-white/80 hover:text-white transition-all"
                  title="Next Episode"
                >
                  <FastForward className="w-4 h-4" />
                </button>
              )}

              {/* Volume Slider */}
              <div className="flex items-center space-x-1.5 group">
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center text-white/80 hover:text-white transition-all"
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
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    setVolume(parseFloat(e.target.value));
                    setIsMuted(false);
                  }}
                  className="w-14 sm:w-20 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
                />
              </div>

              {/* Time Display */}
              <div className="text-xs font-mono text-white/70 select-none hidden sm:block">
                <span>{formatTime(currentTime)}</span>
                <span className="text-white/30 mx-1">/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Right Controls */}
            <div className="flex items-center space-x-1.5 sm:space-x-2">
              {/* Subtitles Button */}
              <div className="relative">
                <button
                  onClick={() => setShowSubMenu(!showSubMenu)}
                  className={`w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center transition-all ${
                    activeSubtitleId !== 'off' ? 'text-cyan-400' : 'text-white/70 hover:text-white'
                  }`}
                  title="Subtitles"
                >
                  <Subtitles className="w-4 h-4" />
                </button>

                {showSubMenu && (
                  <div className="absolute bottom-11 right-0 w-56 p-2 rounded-2xl bg-[#1c1c1f]/95 border border-white/15 shadow-2xl backdrop-blur-2xl text-xs space-y-1 z-50 animate-fade-in max-h-72 overflow-y-auto">
                    <p className="px-3 py-1 text-[10px] uppercase font-bold text-white/40 tracking-wider">Subtitles</p>
                    <button
                      onClick={() => handleSelectSubtitle('off')}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all ${
                        activeSubtitleId === 'off' ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      <span>Off</span>
                      {activeSubtitleId === 'off' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                    </button>
                    {availableSubtitles.map((sub) => (
                      <button
                        key={sub.id}
                        onClick={() => handleSelectSubtitle(sub.id, sub.trackNumber)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all ${
                          activeSubtitleId === sub.id ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                        }`}
                      >
                        <span className="truncate pr-2">{sub.label}</span>
                        {activeSubtitleId === sub.id && <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
                      </button>
                    ))}
                    {availableSubtitles.length === 0 && (
                      <div className="px-3 py-2 text-white/40 text-[11px] italic">
                        No subtitles in video
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Multi-Audio Track Selector */}
              {audioTracks.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => setShowAudioMenu(!showAudioMenu)}
                    className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white transition-all"
                    title="Audio Tracks"
                  >
                    <Volume2 className="w-4 h-4" />
                  </button>

                  {showAudioMenu && (
                    <div className="absolute bottom-11 right-0 w-44 p-2 rounded-2xl bg-[#1c1c1f]/95 border border-white/15 shadow-2xl backdrop-blur-2xl text-xs space-y-1 z-50">
                      <p className="px-3 py-1 text-[10px] uppercase font-bold text-white/40 tracking-wider">Audio Tracks</p>
                      {audioTracks.map((tr) => (
                        <button
                          key={tr.id}
                          onClick={() => handleSelectAudioTrack(tr.id)}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all ${
                            activeAudioTrackId === tr.id ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                          }`}
                        >
                          <span className="truncate">{tr.label}</span>
                          {activeAudioTrackId === tr.id && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TMPlayer Quality Selector */}
              <div className="relative">
                <button
                  onClick={() => setShowQualityMenu(!showQualityMenu)}
                  className="px-2 py-1 rounded-full hover:bg-white/15 text-xs font-semibold text-white/80 hover:text-white transition-all uppercase"
                  title="Quality Selection"
                >
                  {selectedQuality}
                </button>

                {showQualityMenu && (
                  <div className="absolute bottom-11 right-0 w-44 p-2 rounded-2xl bg-[#1c1c1f]/95 border border-white/15 shadow-2xl backdrop-blur-2xl text-xs space-y-1 z-50">
                    <p className="px-3 py-1 text-[10px] uppercase font-bold text-white/40 tracking-wider">Quality</p>
                    <button
                      onClick={() => {
                        setSelectedQuality('Auto');
                        setShowQualityMenu(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all ${
                        selectedQuality === 'Auto' ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      <span>Auto (1.3× Headroom)</span>
                      {selectedQuality === 'Auto' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                    </button>
                    {(item.availableQualities && item.availableQualities.length > 0
                      ? item.availableQualities
                      : [{ label: `${item.parsed.resolution || 'Original'}` }]
                    ).map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setSelectedQuality(q.label);
                          setShowQualityMenu(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all ${
                          selectedQuality === q.label ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                        }`}
                      >
                        <span className="truncate">{q.label}</span>
                        {selectedQuality === q.label && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Playback Speed Button */}
              <div className="relative">
                <button
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                  className="px-2 py-1 rounded-full hover:bg-white/15 text-xs font-semibold text-white/80 hover:text-white transition-all"
                  title="Playback Speed"
                >
                  {playbackSpeed}x
                </button>

                {showSpeedMenu && (
                  <div className="absolute bottom-11 right-0 w-36 p-2 rounded-2xl bg-[#1c1c1f]/95 border border-white/15 shadow-2xl backdrop-blur-2xl text-xs space-y-1 z-50">
                    <p className="px-3 py-1 text-[10px] uppercase font-bold text-white/40 tracking-wider">Speed</p>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((spd) => (
                      <button
                        key={spd}
                        onClick={() => handleSpeedSelect(spd)}
                        className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-left transition-all ${
                          playbackSpeed === spd ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10'
                        }`}
                      >
                        <span>{spd}x</span>
                        {playbackSpeed === spd && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Fullscreen Button */}
              <button
                onClick={toggleFullscreen}
                className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center text-white/80 hover:text-white transition-all"
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
