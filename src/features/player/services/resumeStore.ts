// src/features/player/services/resumeStore.ts
// TMPlayer-inspired Persistent Playback State Store (localStorage + IndexedDB)

import { streamDb } from '../../../db/streamDb';

export interface PlaybackResumeState {
  fileId: string;
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: number;
  completed: boolean;
}

const LOCAL_STORAGE_PREFIX = 'tmplayer_resume_';

export class ResumeStore {
  /**
   * Save playback position synchronously to localStorage and asynchronously to IndexedDB.
   */
  public async savePlaybackPosition(
    fileId: string,
    positionSeconds: number,
    durationSeconds: number = 0,
    completed: boolean = false
  ): Promise<void> {
    if (!fileId || positionSeconds < 0) return;

    const isDone = completed || (durationSeconds > 0 && positionSeconds / durationSeconds >= 0.95);
    const record: PlaybackResumeState = {
      fileId,
      positionSeconds: isDone ? 0 : Math.round(positionSeconds * 100) / 100,
      durationSeconds: Math.round(durationSeconds),
      updatedAt: Date.now(),
      completed: isDone,
    };

    // 1. Fast synchronous write to localStorage for instant tab-reload retrieval
    try {
      localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${fileId}`, JSON.stringify(record));
    } catch (e) {
      // QuotaExceeded fallback
    }

    // 2. Persistent asynchronous write to IndexedDB
    try {
      const parts = fileId.split('_');
      const chatId = parts[0] || '0';
      await streamDb.playbackProgress.put({
        streamId: fileId,
        chatId,
        positionSec: record.positionSeconds,
        durationSec: record.durationSeconds || 0,
        completed: record.completed,
        playbackSpeed: 1,
        bookmarks: [],
        updatedAt: record.updatedAt,
      });
    } catch (e) {
      // ignore IndexedDB write warning
    }
  }

  /**
   * Synchronously or asynchronously load last saved playback position.
   */
  public async loadPlaybackPosition(fileId: string): Promise<PlaybackResumeState | null> {
    if (!fileId) return null;

    // 1. Check localStorage first
    try {
      const local = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${fileId}`);
      if (local) {
        const parsed = JSON.parse(local) as PlaybackResumeState;
        if (parsed && typeof parsed.positionSeconds === 'number') {
          return parsed;
        }
      }
    } catch (e) {}

    // 2. Fallback to IndexedDB
    try {
      const dbRec = await streamDb.playbackProgress.get(fileId);
      if (dbRec && dbRec.positionSec > 0) {
        return {
          fileId,
          positionSeconds: dbRec.positionSec,
          durationSeconds: dbRec.durationSec,
          updatedAt: dbRec.updatedAt,
          completed: dbRec.completed,
        };
      }
    } catch (e) {}

    return null;
  }

  /**
   * Synchronous load for immediate mount initialization without promise wait
   */
  public loadPlaybackPositionSync(fileId: string): PlaybackResumeState | null {
    if (!fileId) return null;
    try {
      const local = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${fileId}`);
      if (local) {
        return JSON.parse(local) as PlaybackResumeState;
      }
    } catch (e) {}
    return null;
  }

  /**
   * Clear resume state (e.g. video finished)
   */
  public async clearPlaybackPosition(fileId: string): Promise<void> {
    if (!fileId) return;
    try {
      localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${fileId}`);
    } catch (e) {}
    try {
      await streamDb.playbackProgress.delete(fileId);
    } catch (e) {}
  }
}

export const resumeStore = new ResumeStore();

