// src/features/player/services/fileStreamService.ts
// TMPlayer-inspired File Stream Metadata & Range Streaming Contract

import { streamDb } from '../../../db/streamDb';
import { tgStreamEngine } from '../../../services/tgStreamEngine';
import { ensureStreamServiceWorker } from '../../../services/swRegistration';

export interface FileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  duration: number;
  streamUrl: string;
}

export class FileStreamService {
  /**
   * Fetches metadata according to the API contract:
   * GET /api/files/:id
   * Response: { id, name, mimeType, size, duration, streamUrl }
   */
  public async getFileMetadata(fileId: string): Promise<FileMetadata> {
    await ensureStreamServiceWorker();

    // 1. Try local streamDb descriptor cache
    try {
      const desc = await streamDb.streamDescriptors.get(fileId);
      if (desc && desc.totalSize > 0) {
        return {
          id: desc.streamId,
          name: desc.fileName || 'media',
          mimeType: desc.mimeType || 'video/mp4',
          size: desc.totalSize,
          duration: (desc as any).duration || 0,
          streamUrl: this.getStreamUrl(fileId),
        };
      }
    } catch (e) {}

    // 2. Fetch from Service Worker route
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {}

    // Fallback descriptor
    return {
      id: fileId,
      name: 'video.mp4',
      mimeType: 'video/mp4',
      size: 0,
      duration: 0,
      streamUrl: this.getStreamUrl(fileId),
    };
  }

  /**
   * Returns range-enabled HTTP 206 stream endpoint:
   * GET /api/files/:id/stream
   */
  public getStreamUrl(fileId: string): string {
    return `/api/files/${encodeURIComponent(fileId)}/stream`;
  }

  /**
   * Pre-heats the stream descriptor and verifies Service Worker readiness
   */
  public async prepareStream(
    fileId: string,
    chatId: string,
    messageId: number,
    doc: any,
    fileName: string,
    mimeType: string,
    duration: number = 0
  ): Promise<FileMetadata> {
    await ensureStreamServiceWorker();

    await tgStreamEngine.registerStream(
      chatId,
      messageId,
      doc,
      fileName,
      mimeType
    );

    return {
      id: fileId,
      name: fileName,
      mimeType,
      size: doc.size ? Number(doc.size) : 0,
      duration,
      streamUrl: this.getStreamUrl(fileId),
    };
  }
}

export const fileStreamService = new FileStreamService();
