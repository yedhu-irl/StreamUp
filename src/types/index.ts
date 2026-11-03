export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramSession {
  stringSession: string;
  phoneNumber?: string;
  userId?: string;
  firstName?: string;
  username?: string;
}

export interface ChannelCategory {
  id: string; // telegram channel/chat id (e.g. "-1001234567890")
  title: string;
  username?: string;
  accessHash?: string;
  videoCount?: number;
  lastScanned?: number;
  enabled?: boolean; // Select/Deselect category toggle (true by default)
  contentType?: 'movies' | 'series' | 'all'; // Movies vs Series category selection
}

export interface TelegramUserProfile {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
  photoUrl?: string | null;
}

export interface TMDBCastMember {
  name: string;
  character?: string;
  profilePath: string | null;
}

export interface ParsedMediaInfo {
  cleanTitle: string;
  year?: number;
  season?: number;
  episode?: number;
  resolution?: string; // "4K", "1080p", "720p", "480p"
  codec?: string; // "HEVC", "x264", "AAC"
  quality?: string; // "WEB-DL", "BluRay", "HDR"
  isSeries: boolean;
  originalFileName: string;
}

export interface TMDBMediaMetadata {
  id: number;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  releaseDate: string;
  genres: string[];
  cast: string[];
  castMembers?: TMDBCastMember[];
  isSeries: boolean;
  totalSeasons?: number;
}

export interface VideoQualityOption {
  label: string; // "1080p", "720p", "480p", "Original"
  resolution?: string;
  fileSize?: number;
  docId?: string;
}

export interface ChannelVideoItem {
  id: string; // `${channelId}_${messageId}`
  channelId: string;
  messageId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  duration?: number;
  parsed: ParsedMediaInfo;
  tmdb: TMDBMediaMetadata | null;
  date: number;
  subtitleMessageId?: number; // Optional matched .srt message
  availableQualities?: VideoQualityOption[];
}

export interface SeriesEpisode {
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  title: string;
  overview?: string;
  stillPath?: string | null;
  voteAverage?: number;
  runtime?: number;
  airDate?: string;
  videoItem: ChannelVideoItem;
}

export interface SeriesGroup {
  showTitle: string;
  tmdb: TMDBMediaMetadata | null;
  seasons: Record<number, SeriesEpisode[]>;
  totalEpisodes: number;
  channelId: string;
}

export interface WatchProgress {
  id: string; // video item id
  channelId: string;
  messageId: number;
  currentTime: number;
  duration: number;
  updatedAt: number;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  episodeInfo?: string; // e.g. "S1 E3"
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  src: string; // blob or data url
  isDefault?: boolean;
}

