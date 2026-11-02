import Dexie, { type Table } from 'dexie';

export const CHUNK_SIZE = 512 * 1024; // 524,288 bytes (512 KB - strictly 4KB aligned & divides 1MB)

export interface VideoChunkRecord {
  id: string;          // "${streamId}_${chunkIndex}"
  streamId: string;    // "${chatId}_${messageId}"
  chunkIndex: number;  // Math.floor(byteOffset / CHUNK_SIZE)
  data: Uint8Array;    // Raw chunk bytes (up to 524,288 bytes)
  byteLength: number;
  createdAt: number;
}

export interface StreamDescriptorRecord {
  streamId: string;    // "${chatId}_${messageId}"
  chatId: string;
  messageId: number;
  fileName: string;
  mimeType: string;
  totalSize: number;   // Total size in bytes (or sum of parts)
  dcId: number;
  updatedAt: number;
}

export interface PlaybackProgressRecord {
  streamId: string;
  chatId: string;
  seriesKey?: string;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  playbackSpeed: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  bookmarks: Array<{ id: string; timeSec: number; note: string }>;
  updatedAt: number;
}

export class StreamDatabase extends Dexie {
  videoChunks!: Table<VideoChunkRecord>;
  streamDescriptors!: Table<StreamDescriptorRecord>;
  playbackProgress!: Table<PlaybackProgressRecord>;

  constructor() {
    super('StreamUpMediaDB');
    this.version(1).stores({
      videoChunks: 'id, streamId, chunkIndex, createdAt',
      streamDescriptors: 'streamId, chatId, messageId, updatedAt',
      playbackProgress: 'streamId, chatId, seriesKey, updatedAt',
    });
  }
}

export const streamDb = new StreamDatabase();

/**
 * Single-Video Watch Cache Enforcer:
 * Purges chunks from non-active stream sessions to preserve browser IndexedDB quotas.
 */
export async function enforceActiveStreamCache(activeStreamId: string): Promise<void> {
  try {
    const nonActiveChunks = await streamDb.videoChunks
      .where('streamId')
      .notEqual(activeStreamId)
      .primaryKeys();

    if (nonActiveChunks.length > 0) {
      await streamDb.videoChunks.bulkDelete(nonActiveChunks);
    }
  } catch (err) {
    console.warn('Failed to clear inactive stream cache:', err);
  }
}

/**
 * Evicts chunks outside the active 1-minute window [startChunk, endChunk]
 * while preserving pinned chunks (header & trailer).
 */
export async function evictChunksOutsideWindow(
  streamId: string,
  startChunk: number,
  endChunk: number,
  pinnedChunks: number[]
): Promise<number> {
  try {
    const pinned = new Set(pinnedChunks);
    const records = await streamDb.videoChunks
      .where('streamId')
      .equals(streamId)
      .toArray();

    const toDelete: string[] = [];
    for (const rec of records) {
      if (pinned.has(rec.chunkIndex)) continue;
      if (rec.chunkIndex < startChunk || rec.chunkIndex > endChunk) {
        toDelete.push(rec.id);
      }
    }

    if (toDelete.length > 0) {
      await streamDb.videoChunks.bulkDelete(toDelete);
    }
    return toDelete.length;
  } catch (err) {
    console.warn('Failed to evict chunks outside active window:', err);
    return 0;
  }
}

