import { db } from './db';
import type { TMDBMediaMetadata, TMDBCastMember } from '../types';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

export function getTMDBImageUrl(path: string | null, size: 'w300' | 'w500' | 'w780' | 'w1280' | 'original' = 'w500'): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${size}${path}`;
}

function getCredentials(): { apiKey: string; accessToken: string } {
  const envKey = import.meta.env.VITE_TMDB_API_KEY;
  const envToken = import.meta.env.VITE_TMDB_ACCESS_TOKEN;
  const localKey = localStorage.getItem('streamup_tmdb_key');

  const apiKey = localKey || envKey || '1381e9212d87c29fed4b981b8573c018';
  const accessToken = envToken || '';
  return { apiKey, accessToken };
}

async function fetchWithTimeout(url: string, headers: HeadersInit, timeoutMs = 6000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(id);
    return null;
  }
}

export async function fetchTMDBMetadata(
  rawTitle: string,
  year?: number,
  isSeries = false
): Promise<TMDBMediaMetadata | null> {
  const { apiKey, accessToken } = getCredentials();
  const cleanTitle = cleanSearchTitle(rawTitle);
  const cacheKey = `${isSeries ? 'tv' : 'movie'}:${cleanTitle.toLowerCase()}:${year || 'any'}`;

  // 1. Check IndexedDB cache
  try {
    const cached = await db.tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 1000 * 60 * 60 * 24 * 7) {
      return cached.data;
    }
  } catch (err) {
    console.warn('TMDBCache read error:', err);
  }

  const headers: HeadersInit = {
    Accept: 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  // 2. Perform TMDB Search (support both primary and backup hosts)
  const hosts = ['https://api.themoviedb.org/3', 'https://api.tmdb.org/3'];
  let result: TMDBMediaMetadata | null = null;

  for (const host of hosts) {
    try {
      if (isSeries) {
        result = await searchTV(host, cleanTitle, year, apiKey, headers);
        if (!result) {
          result = await searchMovie(host, cleanTitle, year, apiKey, headers);
        }
      } else {
        result = await searchMovie(host, cleanTitle, year, apiKey, headers);
        if (!result) {
          result = await searchTV(host, cleanTitle, year, apiKey, headers);
        }
      }

      if (result) break; // Found result
    } catch (e) {
      // try next host
    }
  }

  // 3. Fallback: if TMDB found nothing or was unreachable, generate clean structured metadata
  if (!result) {
    result = {
      id: Math.abs(hashCode(cleanTitle)),
      title: cleanTitle,
      overview: 'Available to stream directly from your Telegram channel.',
      posterPath: null,
      backdropPath: null,
      voteAverage: 0,
      releaseDate: year ? `${year}-01-01` : '',
      genres: [],
      cast: [],
      isSeries,
    };
  }

  // 4. Save to cache
  try {
    await db.tmdbCache.put({
      query: cacheKey,
      data: result,
      cachedAt: Date.now(),
    });
  } catch (e) {
    console.warn('TMDBCache write error:', e);
  }

  return result;
}

function cleanSearchTitle(title: string): string {
  let c = title;
  // Remove file extensions
  c = c.replace(/\.[a-zA-Z0-9]{2,4}$/, '');
  // Remove brackets and parens content
  c = c.replace(/\[.*?\]|\(.*?\)/g, ' ');
  // Remove regional language tags and technical tags
  c = c.replace(/\b(malayalam|tamil|hindi|telugu|kannada|english|dual[._\s]audio|multi[._\s]audio|org|original|uncut|hdrip|bluray|web-?dl|webrip|dvdrip|hevc|x264|x265|1080p|720p|4k|2160p|hdtv|aac|esub)\b/gi, ' ');
  // Replace symbols
  c = c.replace(/[._\-]+/g, ' ');
  c = c.replace(/\s{2,}/g, ' ').trim();
  return c || title;
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

async function searchMovie(
  host: string,
  title: string,
  year: number | undefined,
  apiKey: string,
  headers: HeadersInit
): Promise<TMDBMediaMetadata | null> {
  let url = `${host}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
  if (year) url += `&year=${year}`;

  let data = await fetchWithTimeout(url, headers);

  if ((!data || !data.results || data.results.length === 0) && year) {
    // Retry without year
    url = `${host}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
    data = await fetchWithTimeout(url, headers);
  }

  if (!data || !data.results || data.results.length === 0) return null;

  const first = data.results[0];
  const movieId = first.id;

  // Fetch full details and cast
  const detailsUrl = `${host}/movie/${movieId}?api_key=${apiKey}&append_to_response=credits`;
  const details = await fetchWithTimeout(detailsUrl, headers);

  if (details) {
    const rawCast = details.credits?.cast || [];
    const castMembers: TMDBCastMember[] = rawCast.slice(0, 15).map((c: any) => ({
      name: c.name,
      character: c.character,
      profilePath: c.profile_path || null,
    }));
    const cast = castMembers.map((c) => c.name);
    const genres = (details.genres || []).map((g: any) => g.name);

    return {
      id: details.id,
      title: details.title || first.title || title,
      overview: details.overview || first.overview || '',
      posterPath: details.poster_path || first.poster_path,
      backdropPath: details.backdrop_path || first.backdrop_path,
      voteAverage: Number(details.vote_average?.toFixed(1)) || 0,
      releaseDate: details.release_date || first.release_date || '',
      genres,
      cast,
      castMembers,
      isSeries: false,
    };
  }

  return {
    id: first.id,
    title: first.title || title,
    overview: first.overview || '',
    posterPath: first.poster_path,
    backdropPath: first.backdrop_path,
    voteAverage: Number(first.vote_average?.toFixed(1)) || 0,
    releaseDate: first.release_date || '',
    genres: [],
    cast: [],
    isSeries: false,
  };
}

async function searchTV(
  host: string,
  title: string,
  year: number | undefined,
  apiKey: string,
  headers: HeadersInit
): Promise<TMDBMediaMetadata | null> {
  let url = `${host}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
  if (year) url += `&first_air_date_year=${year}`;

  let data = await fetchWithTimeout(url, headers);

  if ((!data || !data.results || data.results.length === 0) && year) {
    url = `${host}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&include_adult=false`;
    data = await fetchWithTimeout(url, headers);
  }

  if (!data || !data.results || data.results.length === 0) return null;

  const first = data.results[0];
  const tvId = first.id;

  const detailsUrl = `${host}/tv/${tvId}?api_key=${apiKey}&append_to_response=credits`;
  const details = await fetchWithTimeout(detailsUrl, headers);

  if (details) {
    const rawCast = details.credits?.cast || [];
    const castMembers: TMDBCastMember[] = rawCast.slice(0, 15).map((c: any) => ({
      name: c.name,
      character: c.character,
      profilePath: c.profile_path || null,
    }));
    const cast = castMembers.map((c) => c.name);
    const genres = (details.genres || []).map((g: any) => g.name);

    return {
      id: details.id,
      title: details.name || first.name || title,
      overview: details.overview || first.overview || '',
      posterPath: details.poster_path || first.poster_path,
      backdropPath: details.backdrop_path || first.backdrop_path,
      voteAverage: Number(details.vote_average?.toFixed(1)) || 0,
      releaseDate: details.first_air_date || first.first_air_date || '',
      genres,
      cast,
      castMembers,
      isSeries: true,
      totalSeasons: details.number_of_seasons || 1,
    };
  }

  return {
    id: first.id,
    title: first.name || title,
    overview: first.overview || '',
    posterPath: first.poster_path,
    backdropPath: first.backdrop_path,
    voteAverage: Number(first.vote_average?.toFixed(1)) || 0,
    releaseDate: first.first_air_date || '',
    genres: [],
    cast: [],
    isSeries: true,
    totalSeasons: 1,
  };
}

/**
 * On-demand credits fetcher for movies/series to retrieve cast photos
 */
export async function fetchCastForMedia(tmdbId: number, isSeries = false): Promise<TMDBCastMember[]> {
  const { apiKey, accessToken } = getCredentials();
  const headers: HeadersInit = { Accept: 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const hosts = ['https://api.themoviedb.org/3', 'https://api.tmdb.org/3'];
  const endpoint = isSeries ? 'tv' : 'movie';

  for (const host of hosts) {
    try {
      const url = `${host}/${endpoint}/${tmdbId}/credits?api_key=${apiKey}`;
      const data = await fetchWithTimeout(url, headers, 4000);
      if (data && data.cast) {
        return (data.cast as any[]).slice(0, 15).map((c: any) => ({
          name: c.name,
          character: c.character,
          profilePath: c.profile_path || null,
        }));
      }
    } catch (e) {
      // try next host
    }
  }
  return [];
}

export interface TMDBEpisodeDetail {
  episodeNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  voteAverage: number;
  runtime?: number;
  airDate?: string;
}

/**
 * Fetch detailed episode information (titles, overviews, ratings, still preview photos) for a TV season
 */
export async function fetchTMDBSeasonEpisodes(
  tvId: number,
  seasonNumber: number
): Promise<Record<number, TMDBEpisodeDetail>> {
  const cacheKey = `tv_season:${tvId}:${seasonNumber}`;
  try {
    const cached = await db.tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 1000 * 60 * 60 * 24 * 7) {
      return cached.data;
    }
  } catch (e) {
    // ignore
  }

  const { apiKey, accessToken } = getCredentials();
  const headers: HeadersInit = { Accept: 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const hosts = ['https://api.themoviedb.org/3', 'https://api.tmdb.org/3'];

  for (const host of hosts) {
    try {
      const url = `${host}/tv/${tvId}/season/${seasonNumber}?api_key=${apiKey}`;
      const data = await fetchWithTimeout(url, headers, 5000);
      if (data && data.episodes && Array.isArray(data.episodes)) {
        const result: Record<number, TMDBEpisodeDetail> = {};
        for (const ep of data.episodes) {
          result[ep.episode_number] = {
            episodeNumber: ep.episode_number,
            name: ep.name || `Episode ${ep.episode_number}`,
            overview: ep.overview || '',
            stillPath: ep.still_path || null,
            voteAverage: Number(ep.vote_average?.toFixed(1)) || 0,
            runtime: ep.runtime || undefined,
            airDate: ep.air_date || undefined,
          };
        }
        try {
          await db.tmdbCache.put({
            query: cacheKey,
            data: result,
            cachedAt: Date.now(),
          });
        } catch (err) {}
        return result;
      }
    } catch (e) {
      // try next host
    }
  }

  return {};
}

