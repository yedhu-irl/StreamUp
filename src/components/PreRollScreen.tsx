import React, { useState, useEffect } from 'react';
import { ArrowLeft, Star, Film, Tv, ShieldCheck, Zap } from 'lucide-react';
import type { ChannelVideoItem } from '../types';
import { getTMDBImageUrl } from '../services/tmdb';
import { resolveCachedDocument } from '../services/telegram';
import { tgStreamEngine } from '../services/tgStreamEngine';
import { ensureStreamServiceWorker } from '../services/swRegistration';

interface PreRollScreenProps {
  item: ChannelVideoItem;
  initialTime?: number;
  onReady: () => void;
  onCancel: () => void;
}

export const PreRollScreen: React.FC<PreRollScreenProps> = ({
  item,
  initialTime = 0,
  onReady,
  onCancel,
}) => {
  const [percent, setPercent] = useState<number>(0);
  const [speedBytes, setSpeedBytes] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('Reading the video...');
  const [canStartEarly, setCanStartEarly] = useState<boolean>(false);
  const [showPlayNow, setShowPlayNow] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const title = item.tmdb?.title || item.parsed.cleanTitle;
  const overview =
    item.tmdb?.overview ||
    'High-definition video ready for instant client-side playback directly from Telegram MTProto cloud.';
  const backdropUrl = getTMDBImageUrl(item.tmdb?.backdropPath || null, 'original');
  const posterUrl = getTMDBImageUrl(item.tmdb?.posterPath || null, 'w500');
  const rating = item.tmdb?.voteAverage;
  const year = item.tmdb?.releaseDate
    ? new Date(item.tmdb.releaseDate).getFullYear()
    : item.parsed.year;
  const isSeries = item.parsed.isSeries;
  const streamId = `${item.channelId}_${item.messageId}`;

  // Keyboard shortcut: Esc to cancel
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Back') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  // Execute Pre-Roll Staging Buffer (1-Minute Rolling Matrix)
  useEffect(() => {
    let isMounted = true;
    let timer: any = null;
    let hasTriggeredReady = false;

    let isStreamRegistered = false;

    // Fallback timer: Show Play Now button after 4s, and auto-proceed after 8s if registered
    const playNowTimer = setTimeout(() => {
      if (isMounted) setShowPlayNow(true);
    }, 4000);

    const autoProceedTimer = setTimeout(() => {
      if (isMounted && !hasTriggeredReady && isStreamRegistered) {
        hasTriggeredReady = true;
        setStatusMessage('Launching player...');
        onReady();
      }
    }, 8000);

    const startPreload = async () => {
      try {
        setStatusMessage('Connecting stream proxy barrier...');
        await ensureStreamServiceWorker();

        if (!isMounted) return;
        setStatusMessage('Resolving Telegram cloud document...');
        const cached = await resolveCachedDocument(item.channelId, item.messageId);

        if (!cached || !cached.doc) {
          if (isMounted) setError('Unable to locate video file in Telegram channel.');
          return;
        }

        if (!isMounted) return;
        setStatusMessage('Allocating 1-minute playback buffer...');
        const fileName = item.fileName || item.parsed?.originalFileName || 'video.mp4';
        await tgStreamEngine.registerStream(
          item.channelId,
          item.messageId,
          cached.doc,
          fileName,
          cached.mimeType || 'video/mp4'
        );
        isStreamRegistered = true;

        if (!isMounted) return;
        const dur = item.duration || 0;

        await tgStreamEngine.preloadInitialBuffer(
          streamId,
          initialTime,
          dur,
          (pct, speed, status, earlyReady) => {
            if (!isMounted) return;
            setPercent(pct);
            setSpeedBytes(speed);
            setStatusMessage(status);
            if (earlyReady) {
              setCanStartEarly(true);
              if (!hasTriggeredReady) {
                hasTriggeredReady = true;
                setStatusMessage('Buffer ready • Launching player...');
                timer = setTimeout(() => {
                  if (isMounted) onReady();
                }, 150);
              }
            }
          }
        );

        if (!isMounted) return;
        setPercent(100);
        setStatusMessage('Buffer ready • Launching player...');

        if (!hasTriggeredReady) {
          hasTriggeredReady = true;
          timer = setTimeout(() => {
            if (isMounted) onReady();
          }, 150);
        }
      } catch (err: any) {
        console.error('Pre-roll buffering failed:', err);
        if (isMounted) {
          setError(err.message || 'Stream pre-buffer failed');
        }
      }
    };

    startPreload();

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
      clearTimeout(playNowTimer);
      clearTimeout(autoProceedTimer);
    };
  }, [item, streamId, initialTime, onReady]);

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec <= 0) return '';
    if (bytesPerSec >= 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col justify-between overflow-hidden animate-fade-in select-none">
      {/* Background Cinematic Art with Multi-Stop Dark Vignettes */}
      <div className="absolute inset-0 pointer-events-none">
        {backdropUrl ? (
          <img
            src={backdropUrl}
            alt={title}
            className="w-full h-full object-cover opacity-40 scale-105 filter blur-xs transition-opacity duration-700"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-tr from-black via-zinc-950 to-zinc-900" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/30" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent w-full md:w-3/4" />
      </div>

      {/* Top Header Back Button & Optional Play Now Button */}
      <div className="relative z-10 px-6 md:px-12 pt-8 flex items-center justify-between">
        <button
          onClick={onCancel}
          className="w-10 h-10 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex items-center justify-center backdrop-blur-xl transition-all shadow-md"
          title="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {canStartEarly && percent < 100 && (
          <button
            onClick={onReady}
            className="flex items-center space-x-2 px-5 py-2 rounded-full bg-white text-black font-semibold text-xs hover:bg-white/90 active:scale-95 shadow-xl transition-all animate-fade-in"
          >
            <Zap className="w-3.5 h-3.5 fill-black text-black" />
            <span>Play Now</span>
          </button>
        )}
      </div>

      {/* Bottom Information & Progress Bar matching screenshot */}
      <div className="relative z-10 px-6 md:px-12 pb-12 max-w-5xl w-full space-y-6">
        <div className="flex items-end space-x-6">
          {/* Vertical Poster Card */}
          <div className="hidden sm:block flex-none w-[110px] md:w-[130px] aspect-[2/3] rounded-2xl overflow-hidden bg-zinc-900 border border-white/20 shadow-2xl">
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center text-white/40">
                {isSeries ? <Tv className="w-8 h-8 mb-1" /> : <Film className="w-8 h-8 mb-1" />}
                <span className="text-[10px] font-semibold">{title}</span>
              </div>
            )}
          </div>

          {/* Details */}
          <div className="space-y-2.5 max-w-2xl min-w-0">
            <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-white drop-shadow-md">
              {title}
            </h1>

            <div className="flex items-center flex-wrap gap-2.5 text-xs text-white/70">
              {year && <span>{year}</span>}
              {year && <span>&bull;</span>}
              <span>{item.tmdb?.genres?.join(', ') || (isSeries ? 'TV Series' : 'Movie')}</span>
              {rating && (
                <>
                  <span>&bull;</span>
                  <div className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 font-semibold text-[11px]">
                    <span>TMDB</span>
                    <Star className="w-3 h-3 fill-cyan-400 text-cyan-400" />
                    <span>{rating.toFixed(1)}</span>
                  </div>
                </>
              )}
            </div>

            <p className="text-xs md:text-sm text-white/70 line-clamp-3 leading-relaxed">
              {overview}
            </p>
          </div>
        </div>

        {/* Progress Bar & Status */}
        <div className="space-y-2 pt-2">
          {error ? (
            <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
              <span>{error}</span>
              <button
                onClick={onCancel}
                className="px-4 py-1.5 rounded-full bg-white text-black font-semibold text-xs"
              >
                Return to Browse
              </button>
            </div>
          ) : (
            <>
              <div className="relative w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all duration-200 ease-out shadow-[0_0_12px_rgba(6,182,212,0.8)]"
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-white/70 font-mono">
                <div className="flex items-center space-x-2">
                  <span className="font-sans text-white/90 font-medium">
                    {statusMessage || 'Reading the video...'}
                  </span>
                  {percent > 0 && <span className="text-white/40">({percent}%)</span>}
                </div>
                <div className="flex items-center space-x-3">
                  {speedBytes > 0 && (
                    <span className="text-emerald-400 font-semibold">{formatSpeed(speedBytes)}</span>
                  )}
                  {showPlayNow && (
                    <button
                      onClick={onReady}
                      className="px-3 py-1 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black font-semibold font-sans text-xs flex items-center space-x-1 transition shadow-lg shadow-cyan-500/20"
                    >
                      <Zap className="w-3 h-3 fill-black text-black" />
                      <span>Play Now</span>
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

