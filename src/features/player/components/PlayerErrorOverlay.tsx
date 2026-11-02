// src/features/player/components/PlayerErrorOverlay.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  RotateCcw,
  ArrowLeft,
  AlertCircle,
  PlayCircle,
  Film,
  Tv,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { ChannelVideoItem } from '../../../types';
import { getTMDBImageUrl } from '../../../services/tmdb';
import { translatePlayerError, type PlayerErrorDetails } from '../types';

export interface PlayerErrorOverlayProps {
  media?: ChannelVideoItem | null;
  error: PlayerErrorDetails | string | null;
  onRetry: () => void;
  onClose: () => void;
  onPlayNext?: () => void;
  nextEpisode?: ChannelVideoItem | null;
}

export const PlayerErrorOverlay: React.FC<PlayerErrorOverlayProps> = ({
  media,
  error,
  onRetry,
  onClose,
  onPlayNext,
  nextEpisode,
}) => {
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(false);
  const [posterLoaded, setPosterLoaded] = useState<boolean>(true);
  const [backdropLoaded, setBackdropLoaded] = useState<boolean>(true);
  const retryButtonRef = useRef<HTMLButtonElement>(null);

  const errorDetails: PlayerErrorDetails = translatePlayerError(error);

  const title =
    media?.tmdb?.title ||
    media?.parsed?.cleanTitle ||
    media?.fileName ||
    'Playback Interrupted';

  const isSeries = Boolean(media?.parsed?.isSeries);
  const season = media?.parsed?.season;
  const episode = media?.parsed?.episode;

  const episodeBadge =
    season !== undefined && episode !== undefined
      ? `S${String(season).padStart(2, '0')} • E${String(episode).padStart(2, '0')}`
      : null;

  const rawBackdropPath = media?.tmdb?.backdropPath || null;
  const rawPosterPath = media?.tmdb?.posterPath || null;

  const backdropUrl = rawBackdropPath ? getTMDBImageUrl(rawBackdropPath, 'original') : null;
  const posterUrl = rawPosterPath ? getTMDBImageUrl(rawPosterPath, 'w500') : null;

  // Auto-focus primary "Retry" button on mount for TV remote / keyboard navigation
  useEffect(() => {
    const timer = setTimeout(() => {
      retryButtonRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Global TV remote / keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Playback Error"
      className="absolute inset-0 z-50 flex flex-col justify-between overflow-hidden select-none bg-black text-white animate-fade-in font-sans"
    >
      {/* ── 1. Media Presentation Layer ── */}
      <div className="absolute inset-0 pointer-events-none">
        {backdropUrl && backdropLoaded ? (
          <img
            src={backdropUrl}
            alt=""
            onError={() => setBackdropLoaded(false)}
            className="w-full h-full object-cover scale-105 filter blur-md opacity-25 transition-opacity duration-700"
          />
        ) : (
          /* Graceful Fallback: Apple TV dark mesh gradient placeholder */
          <div className="w-full h-full bg-gradient-to-tr from-black via-[#08080a] to-[#121214]" />
        )}

        {/* Apple TV Frosted Dark Gradient Overlay: rgba(0,0,0,0.85) / blurred */}
        <div className="absolute inset-0 bg-black/85 backdrop-blur-2xl" />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/40" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent w-full md:w-3/4" />
      </div>

      {/* Top Header Bar */}
      <div className="relative z-10 px-6 md:px-12 pt-6 md:pt-8 flex items-center justify-between pointer-events-auto">
        <button
          onClick={onClose}
          aria-label="Back"
          className="w-10 h-10 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex items-center justify-center backdrop-blur-xl transition-all shadow-md focus:outline-hidden focus:ring-2 focus:ring-white"
          title="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {episodeBadge && (
          <span className="px-3.5 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-semibold tracking-wider uppercase text-white/70 backdrop-blur-md">
            {episodeBadge}
          </span>
        )}
      </div>

      {/* ── 2. Center Content Card: Apple TV Frosted Glass Sheet ── */}
      <div className="relative z-10 px-6 md:px-12 py-6 max-w-4xl w-full mx-auto my-auto pointer-events-auto">
        <div className="rounded-[32px] bg-[#121214]/90 border border-white/15 border-t-white/20 shadow-[0_25px_80px_rgba(0,0,0,0.9)] backdrop-blur-3xl p-6 md:p-8 flex flex-col md:flex-row items-center md:items-start gap-6 md:gap-8">
          {/* Poster Column: 2:3 aspect ratio, rounded corners, drop shadow */}
          <div className="flex-none w-[110px] md:w-[130px] aspect-[2/3] rounded-2xl overflow-hidden bg-[#161618] border border-white/15 shadow-2xl shadow-black/80">
            {posterUrl && posterLoaded ? (
              <img
                src={posterUrl}
                alt={title}
                onError={() => setPosterLoaded(false)}
                className="w-full h-full object-cover"
              />
            ) : (
              /* Fallback: Frosted glass dark mesh gradient card with subtle film/TV icon */
              <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center bg-gradient-to-br from-[#1c1c20] to-[#0a0a0c] text-white/40">
                {isSeries ? (
                  <Tv className="w-8 h-8 mb-2 text-white/30" />
                ) : (
                  <Film className="w-8 h-8 mb-2 text-white/30" />
                )}
                <span className="text-[10px] font-semibold text-white/50 line-clamp-3 leading-tight">
                  {title}
                </span>
              </div>
            )}
          </div>

          {/* Details & Actions Column */}
          <div className="flex-1 min-w-0 flex flex-col items-center md:items-start text-center md:text-left space-y-4 w-full">
            {/* Title & Metadata */}
            <div className="space-y-1 w-full">
              <div className="flex items-center justify-center md:justify-start gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/25 text-rose-400 text-[11px] font-bold tracking-wide uppercase">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {errorDetails.title}
                </span>
                {episodeBadge && (
                  <span className="text-xs text-white/50 font-medium md:inline hidden">
                    {episodeBadge}
                  </span>
                )}
              </div>
              <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight truncate">
                {title}
              </h2>
            </div>

            {/* Clear, Human-Friendly Explanation */}
            <p className="text-sm md:text-base text-white/75 leading-relaxed max-w-xl">
              {errorDetails.message}
            </p>

            {/* Collapsible "Technical Details" Accordion */}
            <div className="w-full pt-1">
              <button
                type="button"
                onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                className="inline-flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors focus:outline-hidden focus:underline"
              >
                <span>Technical Details</span>
                {showTechnicalDetails ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>

              {showTechnicalDetails && (
                <div className="mt-2 p-3 rounded-xl bg-black/60 border border-white/10 text-xs font-mono text-white/70 space-y-1.5 text-left animate-fade-in max-h-36 overflow-y-auto">
                  <div className="flex items-center gap-2">
                    <span className="text-white/40 uppercase tracking-wider text-[10px]">Code:</span>
                    <span className="text-white/90 font-semibold">{errorDetails.code}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-white/40 uppercase tracking-wider text-[10px]">Name:</span>
                    <span className="text-white/90">{errorDetails.title}</span>
                  </div>
                  <div>
                    <span className="text-white/40 uppercase tracking-wider text-[10px] block mb-0.5">
                      Raw Message:
                    </span>
                    <p className="text-rose-300 break-all text-[11px] leading-snug">
                      {errorDetails.technicalDetails || errorDetails.message}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* ── 3. Functional Navigation & Action Controls ── */}
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 pt-2 w-full">
              {/* Primary "Retry" Button */}
              <button
                ref={retryButtonRef}
                onClick={onRetry}
                data-nav-group="player-error"
                data-nav-index="0"
                className="px-7 py-3 rounded-full bg-white text-black font-semibold text-xs md:text-sm hover:bg-white/90 active:scale-95 shadow-[0_0_25px_rgba(255,255,255,0.25)] transition-all flex items-center space-x-2 focus:outline-hidden focus:ring-4 focus:ring-white"
              >
                <RotateCcw className="w-4 h-4 shrink-0" />
                <span>Retry Stream</span>
              </button>

              {/* Optional "Play Next Episode" Button */}
              {(Boolean(nextEpisode) || Boolean(onPlayNext)) && (
                <button
                  onClick={() => {
                    if (onPlayNext) {
                      onPlayNext();
                    }
                  }}
                  data-nav-group="player-error"
                  data-nav-index="1"
                  className="px-6 py-3 rounded-full bg-white/15 hover:bg-white/25 active:scale-95 border border-white/20 text-white text-xs md:text-sm font-semibold transition-all flex items-center space-x-2 focus:outline-hidden focus:ring-4 focus:ring-white"
                >
                  <PlayCircle className="w-4 h-4 shrink-0" />
                  <span>
                    Play Next Episode
                    {nextEpisode?.parsed?.episode ? ` (E${nextEpisode.parsed.episode})` : ''}
                  </span>
                </button>
              )}

              {/* Secondary "Back" / "Play Another" Button */}
              <button
                onClick={onClose}
                data-nav-group="player-error"
                data-nav-index={Boolean(nextEpisode) || Boolean(onPlayNext) ? '2' : '1'}
                className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white/90 text-xs md:text-sm font-semibold transition-all flex items-center space-x-2 focus:outline-hidden focus:ring-4 focus:ring-white"
              >
                <ArrowLeft className="w-4 h-4 shrink-0" />
                <span>Back to Browse</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Spacer / Ambient Cushion */}
      <div className="relative z-10 px-6 pb-6 text-center text-[11px] text-white/30 pointer-events-none">
        StreamUp Player &bull; Press Enter to Retry or Esc to Go Back
      </div>
    </div>
  );
};
