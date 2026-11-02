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
  const [statusMessage, setStatusMessage] = useState<string>('Initializing stream proxy...');
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
  const resolution = item.parsed.resolution || '1080p';
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

  // Execute Pre-Roll Staging Buffer
  useEffect(() => {
    let isMounted = true;
    let timer: any = null;

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
        setStatusMessage('Allocating 30-second ring cache...');
        const fileName = item.fileName || item.parsed?.originalFileName || 'video.mp4';
        await tgStreamEngine.registerStream(
          item.channelId,
          item.messageId,
          cached.doc,
          fileName,
          cached.mimeType || 'video/mp4'
        );

        if (!isMounted) return;
        const dur = item.duration || 0;

        await tgStreamEngine.preloadInitialBuffer(
          streamId,
          initialTime,
          dur,
          (pct, speed, status) => {
            if (!isMounted) return;
            setPercent(pct);
            setSpeedBytes(speed);
            setStatusMessage(status);
          }
        );

        if (!isMounted) return;
        setPercent(100);
        setStatusMessage('Buffer ready • Launching player...');

        // Smooth 250ms cross-fade into player
        timer = setTimeout(() => {
          if (isMounted) onReady();
        }, 250);
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
            className="w-full h-full object-cover opacity-35 scale-105 filter blur-xs transition-opacity duration-700"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-tr from-black via-zinc-950 to-zinc-900" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/40" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent w-full md:w-4/5" />
      </div>

      {/* Top Header Glass Navigation */}
      <div className="relative z-10 px-6 md:px-14 pt-8 flex items-center justify-between">
        <button
          onClick={onCancel}
          className="flex items-center space-x-2 px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-xs font-semibold backdrop-blur-2xl transition-all shadow-xl"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Cancel</span>
        </button>

        <div className="flex items-center space-x-2 px-4 py-1.5 rounded-full bg-black/60 border border-white/15 backdrop-blur-2xl text-[11px] font-medium text-white/80">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Pre-Buffering 60s Zero-Stutter Ring</span>
        </div>
      </div>

      {/* Main Content: Poster on Left, Details & Progress on Right */}
      <div className="relative z-10 px-6 md:px-14 py-8 max-w-6xl mx-auto w-full flex-1 flex flex-col justify-center">
        <div className="flex flex-col md:flex-row items-center md:items-start gap-8 lg:gap-14">
          {/* Vertical Poster Card */}
          <div className="flex-none w-[170px] sm:w-[210px] md:w-[240px] aspect-[2/3] rounded-3xl overflow-hidden bg-zinc-900 border border-white/20 shadow-[0_20px_50px_rgba(0,0,0,0.8)]">
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center text-white/40">
                {isSeries ? <Tv className="w-10 h-10 mb-2" /> : <Film className="w-10 h-10 mb-2" />}
                <span className="text-xs font-semibold">{title}</span>
              </div>
            )}
          </div>

          {/* Details & Live Pre-Roll Progress Capsule */}
          <div className="flex-1 min-w-0 space-y-6 text-center md:text-left">
            {/* Badges */}
            <div className="flex items-center justify-center md:justify-start flex-wrap gap-2 text-xs font-semibold">
              <span className="px-3 py-0.5 rounded-full bg-white/15 border border-white/20 text-[11px] uppercase tracking-wider">
                {isSeries ? 'TV Series' : 'Feature Film'}
              </span>
              <span className="px-2 py-0.5 rounded border border-white/20 text-[10px] font-bold text-white/90">
                {resolution}
              </span>
              <span className="px-2 py-0.5 rounded border border-white/20 text-[10px] font-bold text-white/90">
                HDR
              </span>
              <span className="px-2 py-0.5 rounded border border-white/20 text-[10px] font-bold text-white/90">
                Dolby Atmos
              </span>
              {year && <span className="text-white/60 text-xs ml-1">{year}</span>}
              {rating ? (
                <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-black/60 border border-white/15">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  <span>{rating.toFixed(1)}</span>
                </div>
              ) : null}
            </div>

            {/* Title */}
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white drop-shadow-md">
              {title}
            </h1>

            {/* Synopsis */}
            <p className="text-sm md:text-base text-white/70 max-w-2xl line-clamp-3 leading-relaxed font-normal">
              {overview}
            </p>

            {/* Apple TV Glass Pre-Roll Buffer Progress Capsule */}
            <div className="pt-4 max-w-xl">
              {error ? (
                <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs space-y-3">
                  <p>{error}</p>
                  <button
                    onClick={onCancel}
                    className="px-4 py-2 rounded-full bg-white text-black font-semibold text-xs"
                  >
                    Return to Browse
                  </button>
                </div>
              ) : (
                <div className="p-6 rounded-3xl bg-[#141416]/80 backdrop-blur-3xl border border-white/15 shadow-2xl space-y-4">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-white/90 flex items-center space-x-2">
                      <Zap className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                      <span>{statusMessage}</span>
                    </span>
                    <span className="font-mono text-white text-sm">{percent}%</span>
                  </div>

                  {/* Shimmering Progress Bar */}
                  <div className="relative w-full h-2.5 rounded-full bg-white/10 overflow-hidden border border-white/10">
                    <div
                      className="h-full bg-gradient-to-r from-white via-zinc-100 to-white rounded-full transition-all duration-200 ease-out shadow-[0_0_15px_rgba(255,255,255,0.7)]"
                      style={{ width: `${Math.max(4, percent)}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-white/50 pt-1">
                    <span>Target: 60s Ring Buffer</span>
                    {speedBytes > 0 && (
                      <span className="font-mono text-white/80">{formatSpeed(speedBytes)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Subtle Indicator */}
      <div className="relative z-10 pb-6 text-center text-xs text-white/40">
        Instant playback initiates automatically as soon as the initial 60-second buffer is verified.
      </div>
    </div>
  );
};

