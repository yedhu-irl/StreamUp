import Dexie, { type Table } from 'dexie';
import type { 
  TelegramCredentials, 
  TelegramSession, 
  ChannelCategory, 
  ChannelVideoItem, 
  WatchProgress,
  TMDBMediaMetadata 
} from '../types';

export interface TMDBCacheRecord {
  query: string;
  data: any;
  cachedAt: number;
}

export interface BookmarkRecord {
  id: string; // video item id or show title
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  isSeries: boolean;
  addedAt: number;
}

class StreamUpDatabase extends Dexie {
  credentials!: Table<TelegramCredentials & { id: string }>;
  session!: Table<TelegramSession & { id: string }>;
  channels!: Table<ChannelCategory>;
  videos!: Table<ChannelVideoItem>;
  watchProgress!: Table<WatchProgress>;
  bookmarks!: Table<BookmarkRecord>;
  tmdbCache!: Table<TMDBCacheRecord>;

  constructor() {
    super('StreamUpDB');
    this.version(1).stores({
      credentials: 'id',
      session: 'id',
      channels: 'id, title',
      videos: 'id, channelId, messageId, date',
      watchProgress: 'id, updatedAt, channelId',
      bookmarks: 'id, addedAt',
      tmdbCache: 'query, cachedAt'
    });
  }
}

export const db = new StreamUpDatabase();

// Helper database utilities
export async function getStoredCredentials(): Promise<TelegramCredentials | null> {
  const envId = import.meta.env.VITE_TELEGRAM_API_ID;
  const envHash = import.meta.env.VITE_TELEGRAM_API_HASH;
  if (envId && envHash) {
    const idNum = parseInt(envId, 10);
    if (!isNaN(idNum) && envHash) {
      return { apiId: idNum, apiHash: envHash };
    }
  }

  const creds = await db.credentials.get('default');
  if (creds && creds.apiId && creds.apiHash) {
    return { apiId: creds.apiId, apiHash: creds.apiHash };
  }
  return null;
}

export async function saveStoredCredentials(creds: TelegramCredentials): Promise<void> {
  await db.credentials.put({ id: 'default', ...creds });
}

export async function getStoredSession(): Promise<TelegramSession | null> {
  const session = await db.session.get('default');
  return session || null;
}

export async function saveStoredSession(session: TelegramSession): Promise<void> {
  await db.session.put({ id: 'default', ...session });
}

export async function clearStoredSession(): Promise<void> {
  await db.session.delete('default');
}

export async function saveWatchProgress(progress: WatchProgress): Promise<void> {
  await db.watchProgress.put(progress);
}

export async function getRecentWatchProgress(limit = 12): Promise<WatchProgress[]> {
  return await db.watchProgress
    .orderBy('updatedAt')
    .reverse()
    .limit(limit)
    .toArray();
}

export async function toggleBookmark(item: BookmarkRecord): Promise<boolean> {
  const existing = await db.bookmarks.get(item.id);
  if (existing) {
    await db.bookmarks.delete(item.id);
    return false;
  } else {
    await db.bookmarks.put(item);
    return true;
  }
}

export async function toggleChannelCategory(channelId: string, enabled: boolean): Promise<void> {
  const ch = await db.channels.get(channelId);
  if (ch) {
    ch.enabled = enabled;
    await db.channels.put(ch);
  }
}

export async function isBookmarked(id: string): Promise<boolean> {
  const item = await db.bookmarks.get(id);
  return !!item;
}

