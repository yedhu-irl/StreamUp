// src/features/player/hooks/usePlayerSession.ts
// TMPlayer-inspired Web Player Session Hook (streaming-first, seek-aware, resume-aware)

import { useState, useEffect, useRef, useCallback } from 'react';
import { fileStreamService, type FileMetadata } from '../services/fileStreamService';
import { resumeStore, type PlaybackResumeState } from '../services/resumeStore';
import { PlayerEngine } from '../../../services/playerEngine';
import { tgStreamEngine, type TelemetryEvent } from '../../../services/tgStreamEngine';

export interface UsePlayerSessionOptions {
  fileId: string;
  initialTime?: number;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  duration?: number;
  autoPlay?: boolean;
}

export interface PlayerSessionState {
  metadata: FileMetadata | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isBuffering: boolean;
  playbackStatus: string;
  transferSpeed: number;
  isStalled: boolean;
  playbackError: string | null;
  hasResumePoint: boolean;
  resumeSeconds: number;
}

export function usePlayerSession(options: UsePlayerSessionOptions) {
  const { fileId, initialTime = 0, fileName, mimeType, fileSize, duration: optDuration = 0, autoPlay = true } = options;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerEngineRef = useRef<PlayerEngine | null>(null);

  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(initialTime);
  const [duration, setDuration] = useState<number>(optDuration);
  const [isBuffering, setIsBuffering] = useState<boolean>(true);
  const [playbackStatus, setPlaybackStatus] = useState<string>('Initializing stream...');
  const [transferSpeed, setTransferSpeed] = useState<number>(0);
  const [isStalled, setIsStalled] = useState<boolean>(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [hasResumePoint, setHasResumePoint] = useState<boolean>(false);
  const [resumeSeconds, setResumeSeconds] = useState<number>(0);

  const lastSavedTimeRef = useRef<number>(0);
  const lastPruneTimeRef = useRef<number>(0);

  // ────────────────────────────────────────────
  // 1. Initial Metadata & Resume Point Discovery
  // ────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    async function loadMetaAndResume() {
      // 1. Check saved resume state
      const saved = await resumeStore.loadPlaybackPosition(fileId);
      if (isMounted && saved && !saved.completed && saved.positionSeconds > 5) {
        setHasResumePoint(true);
        setResumeSeconds(saved.positionSeconds);
      }

      // 2. Fetch File Metadata API contract
      const meta = await fileStreamService.getFileMetadata(fileId);
      if (isMounted) {
        setMetadata(meta);
        if (meta.duration > 0 && duration === 0) {
          setDuration(meta.duration);
        }
      }
    }

    loadMetaAndResume();
    return () => {
      isMounted = false;
    };
  }, [fileId]);

  // ────────────────────────────────────────────
  // 2. Start Playback & Attach Engine
  // ────────────────────────────────────────────
  const startPlayback = useCallback(
    async (startFromSeconds?: number) => {
      if (!videoRef.current) return;
      setPlaybackError(null);
      setIsBuffering(true);
      setPlaybackStatus('Connecting stream proxy...');

      const targetStart = typeof startFromSeconds === 'number' ? startFromSeconds : initialTime;

      // Clean up previous engine
      if (playerEngineRef.current) {
        playerEngineRef.current.destroy();
        playerEngineRef.current = null;
      }

      const activeFileName = fileName || metadata?.name || 'video.mp4';
      const activeMimeType = mimeType || metadata?.mimeType || 'video/mp4';
      const activeFileSize = fileSize || metadata?.size || 0;

      const engine = new PlayerEngine({
        videoElement: videoRef.current,
        streamId: fileId,
        fileName: activeFileName,
        mimeType: activeMimeType,
        fileSize: activeFileSize,
        initialTime: targetStart,
        onReady: (dur) => {
          if (dur > 0) setDuration(dur);
          setIsBuffering(false);
          setPlaybackStatus('');
        },
        onStatus: (st) => {
          setPlaybackStatus(st);
        },
        onError: (err) => {
          setPlaybackError(err);
          setIsBuffering(false);
        },
      });

      playerEngineRef.current = engine;
      await engine.start();

      if (autoPlay) {
        videoRef.current.play().catch(() => {
          // Autoplay policy fallback: muted or user interaction required
        });
      }
    },
    [fileId, initialTime, fileName, mimeType, fileSize, metadata, autoPlay]
  );

  // Initialize engine on video element mount
  useEffect(() => {
    let isMounted = true;
    startPlayback().catch((err) => {
      if (isMounted) setPlaybackError(err.message || 'Stream connection failed');
    });

    // Telemetry subscription for live speeds
    const unsubTelemetry = tgStreamEngine.subscribeTelemetry((ev: TelemetryEvent) => {
      if (!isMounted) return;
      setTransferSpeed(ev.speedBytesPerSec);
      setIsStalled(ev.isStalled);
    });

    return () => {
      isMounted = false;
      unsubTelemetry();
      if (playerEngineRef.current) {
        playerEngineRef.current.destroy();
        playerEngineRef.current = null;
      }
    };
  }, [fileId]);

  // ────────────────────────────────────────────
  // 3. Persistent Resume State Management
  // ────────────────────────────────────────────
  const persistCurrentPosition = useCallback(
    (force = false) => {
      const v = videoRef.current;
      if (!v) return;

      const pos = v.currentTime;
      const dur = v.duration || duration;

      if (force || Math.abs(pos - lastSavedTimeRef.current) >= 3) {
        lastSavedTimeRef.current = pos;
        resumeStore.savePlaybackPosition(fileId, pos, dur, dur > 0 && pos / dur >= 0.95);
      }
    },
    [fileId, duration]
  );

  // Auto-save: Every 3s while playing, on pause, on beforeunload, on visibilitychange
  useEffect(() => {
    const interval = setInterval(() => {
      if (isPlaying) {
        persistCurrentPosition(false);
      }
    }, 3000);

    const handleBeforeUnload = () => {
      persistCurrentPosition(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentPosition(true);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      persistCurrentPosition(true);
    };
  }, [isPlaying, persistCurrentPosition]);

  // ────────────────────────────────────────────
  // 4. Playback Actions
  // ────────────────────────────────────────────
  const play = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, []);

  const pause = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
      persistCurrentPosition(true);
    }
  }, [persistCurrentPosition]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const seekTo = useCallback(
    (targetSeconds: number) => {
      const v = videoRef.current;
      if (!v) return;

      const clamped = Math.max(0, Math.min(targetSeconds, duration || 999999));
      playerEngineRef.current?.seek(clamped);
      setCurrentTime(clamped);
      persistCurrentPosition(true);
    },
    [duration, persistCurrentPosition]
  );

  const skipRelative = useCallback(
    (deltaSeconds: number) => {
      const v = videoRef.current;
      if (!v) return;
      seekTo(v.currentTime + deltaSeconds);
    },
    [seekTo]
  );

  const resume = useCallback(() => {
    if (resumeSeconds > 0) {
      seekTo(resumeSeconds);
      setHasResumePoint(false);
      play();
    }
  }, [resumeSeconds, seekTo, play]);

  // ────────────────────────────────────────────
  // 5. HTML5 Media Event Handlers
  // ────────────────────────────────────────────
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;

    const ct = v.currentTime;
    setCurrentTime(ct);

    // Rolling 1-minute buffer pruning every 4 seconds
    if (Math.abs(ct - lastPruneTimeRef.current) >= 4) {
      lastPruneTimeRef.current = ct;
      playerEngineRef.current?.onPlaybackProgress(ct);
    }
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v && v.duration) {
      setDuration(v.duration);
    }
  }, []);

  const onWaiting = useCallback(() => {
    setIsBuffering(true);
  }, []);

  const onCanPlay = useCallback(() => {
    setIsBuffering(false);
    setPlaybackStatus('');
  }, []);

  const onPlaying = useCallback(() => {
    setIsBuffering(false);
    setIsPlaying(true);
    setPlaybackStatus('');
  }, []);

  const onPause = useCallback(() => {
    setIsPlaying(false);
    persistCurrentPosition(true);
  }, [persistCurrentPosition]);

  const onEnded = useCallback(() => {
    setIsPlaying(false);
    resumeStore.savePlaybackPosition(fileId, 0, duration, true);
  }, [fileId, duration]);

  return {
    videoRef,
    state: {
      metadata,
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
    },
    actions: {
      play,
      pause,
      togglePlay,
      seekTo,
      skipRelative,
      resume,
      startPlayback,
      savePlaybackPosition: (sec: number) => resumeStore.savePlaybackPosition(fileId, sec, duration),
      loadPlaybackPosition: () => resumeStore.loadPlaybackPosition(fileId),
      getFileMetadata: () => fileStreamService.getFileMetadata(fileId),
      getStreamUrl: () => fileStreamService.getStreamUrl(fileId),
    },
    mediaProps: {
      onTimeUpdate,
      onLoadedMetadata,
      onWaiting,
      onCanPlay,
      onPlaying,
      onPause,
      onEnded,
    },
  };
}
