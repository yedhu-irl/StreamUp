/**
 * TgFile - Virtual Random-Access File Manager over Telegram MTProto Chunks
 * Based on TMPlayer Web architecture:
 * - 512 KiB fixed chunk sizing (aligned to 4KB, never crosses 1MB boundary)
 * - Parallelism = 4 concurrent MTProto worker slots
 * - Priority job queue (urgent playhead vs speculative lookahead)
 * - Immutable pinned bounds (Chunk 0 header and Tail chunk trailer)
 * - Fast seek job cancellation (dropFarJobs)
 * - Direct L1 RAM LRU + L2 Dexie IndexedDB caching
 */

import { Api, helpers, errors } from 'telegram';
import { getTelegramClient } from '../telegram';
import { streamDb, CHUNK_SIZE, type VideoChunkRecord } from '../../db/streamDb';

export interface TgFileOptions {
  streamId: string;
  chatId: string;
  messageId: number;
  doc: Api.Document;
  totalSize: number;
  dcId: number;
  mimeType: string;
  fileName: string;
}

interface Job {
  index: number;
  urgent: boolean;
  controller: AbortController;
  promise: Promise<Uint8Array>;
  resolve: (b: Uint8Array) => void;
  reject: (e: any) => void;
  started: boolean;
}

export class TgFile {
  public readonly streamId: string;
  public readonly chatId: string;
  public readonly messageId: number;
  public readonly size: number;
  public readonly totalChunks: number;
  public readonly mimeType: string;
  public readonly fileName: string;

  private doc: Api.Document;
  private location: Api.InputDocumentFileLocation;
  private dcId: number;

  // Concurrency & Queue Configuration
  private readonly maxConcurrent = 4;
  private activeWorkers = 0;
  private jobQueue: Job[] = [];
  private inFlightJobs = new Map<number, Job>();

  // Memory & Storage Cache
  private ramCache = new Map<number, Uint8Array>();
  private readonly maxRamChunks: number;
  private pinnedChunks = new Set<number>();
  private downloadedChunks = new Set<number>();

  constructor(options: TgFileOptions) {
    this.streamId = options.streamId;
    this.chatId = options.chatId;
    this.messageId = options.messageId;
    this.doc = options.doc;
    this.size = options.totalSize;
    this.dcId = options.dcId || 1;
    this.mimeType = options.mimeType;
    this.fileName = options.fileName;

    this.totalChunks = Math.max(1, Math.ceil(this.size / CHUNK_SIZE));

    this.location = new Api.InputDocumentFileLocation({
      id: this.doc.id,
      accessHash: this.doc.accessHash,
      fileReference: this.doc.fileReference,
      thumbSize: '',
    });

    // Device memory budget: 48 MB on mobile (~96 chunks), 128 MB on desktop (~256 chunks)
    const isMobile = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    this.maxRamChunks = isMobile ? 96 : 256;

    // Pin immutable bounds: Chunk 0 (header) and Tail chunk (moov / Cues)
    this.pinnedChunks.add(0);
    if (this.totalChunks > 1) this.pinnedChunks.add(1);
    if (this.totalChunks > 2) this.pinnedChunks.add(this.totalChunks - 1);
    if (this.totalChunks > 3) this.pinnedChunks.add(this.totalChunks - 2);

    this.initExistingChunks();
  }

  private async initExistingChunks(): Promise<void> {
    try {
      const records = await streamDb.videoChunks.where('streamId').equals(this.streamId).toArray();
      for (const r of records) {
        this.downloadedChunks.add(r.chunkIndex);
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * Reads an arbitrary byte range [start, end) across chunk boundaries.
   * Stitches and slices exact sub-array requested.
   */
  public async read(start: number, end: number): Promise<Uint8Array> {
    if (start >= this.size) return new Uint8Array(0);
    const clampedEnd = Math.min(end, this.size);
    if (start >= clampedEnd) return new Uint8Array(0);

    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor((clampedEnd - 1) / CHUNK_SIZE);
    const count = lastChunk - firstChunk + 1;

    // Fetch chunks with urgent = true
    const chunkPromises: Promise<Uint8Array>[] = [];
    for (let c = firstChunk; c <= lastChunk; c++) {
      chunkPromises.push(this.getChunk(c, true));
    }

    const chunks = await Promise.all(chunkPromises);

    const totalLength = clampedEnd - start;
    const result = new Uint8Array(totalLength);
    let resultOffset = 0;

    for (let i = 0; i < count; i++) {
      const chunkIdx = firstChunk + i;
      const chunkData = chunks[i];
      const chunkStartByte = chunkIdx * CHUNK_SIZE;
      const chunkEndByte = Math.min(chunkStartByte + chunkData.byteLength, this.size);

      const sliceStart = Math.max(0, start - chunkStartByte);
      const sliceEnd = Math.min(chunkData.byteLength, clampedEnd - chunkStartByte);

      if (sliceStart < chunkData.byteLength && sliceStart < sliceEnd) {
        const slice = chunkData.subarray(sliceStart, sliceEnd);
        result.set(slice, resultOffset);
        resultOffset += slice.byteLength;
      }
    }

    return result;
  }

  /**
   * Fetches or retrieves a 512 KiB chunk via L1 RAM -> L2 Dexie IndexedDB -> MTProto.
   */
  public async getChunk(chunkIndex: number, urgent = false): Promise<Uint8Array> {
    if (chunkIndex < 0 || chunkIndex >= this.totalChunks) {
      throw new Error(`Chunk index ${chunkIndex} out of bounds (total: ${this.totalChunks})`);
    }

    // 1. L1 RAM Cache
    const ram = this.ramCache.get(chunkIndex);
    if (ram) {
      this.touchRam(chunkIndex, ram);
      return ram;
    }

    // 2. L2 Dexie IndexedDB
    try {
      const key = `${this.streamId}_${chunkIndex}`;
      const dbRec = await streamDb.videoChunks.get(key);
      if (dbRec && dbRec.data && dbRec.data.byteLength > 0) {
        this.touchRam(chunkIndex, dbRec.data);
        this.downloadedChunks.add(chunkIndex);
        return dbRec.data;
      }
    } catch (e) {
      // continue to network
    }

    // 3. In-flight job deduplication
    const inFlight = this.inFlightJobs.get(chunkIndex);
    if (inFlight) {
      if (urgent && !inFlight.urgent) {
        inFlight.urgent = true;
      }
      return inFlight.promise;
    }

    // 4. Check existing queued job
    const queued = this.jobQueue.find((j) => j.index === chunkIndex);
    if (queued) {
      if (urgent && !queued.urgent) {
        queued.urgent = true;
        this.sortQueue();
      }
      return queued.promise;
    }

    // 5. Create new Job
    const controller = new AbortController();
    let res!: (b: Uint8Array) => void;
    let rej!: (e: any) => void;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });

    const job: Job = {
      index: chunkIndex,
      urgent,
      controller,
      promise,
      resolve: res,
      reject: rej,
      started: false,
    };

    this.jobQueue.push(job);
    this.sortQueue();
    this.drainQueue();

    // Saturate remaining MTProto worker slots with lookahead chunks [N+1, N+2, N+3]
    this.scheduleLookahead(chunkIndex);

    return promise;
  }

  private scheduleLookahead(baseIndex: number): void {
    const lookaheadCount = 3; // Keep all 4 MTProto workers fully saturated
    let queueChanged = false;

    for (let i = 1; i <= lookaheadCount; i++) {
      const nextIndex = baseIndex + i;
      if (nextIndex >= this.totalChunks) break;
      if (this.ramCache.has(nextIndex) || this.downloadedChunks.has(nextIndex)) continue;
      if (this.inFlightJobs.has(nextIndex)) continue;
      if (this.jobQueue.some((j) => j.index === nextIndex)) continue;

      const controller = new AbortController();
      let res!: (b: Uint8Array) => void;
      let rej!: (e: any) => void;
      const promise = new Promise<Uint8Array>((resolve, reject) => {
        res = resolve;
        rej = reject;
      });

      const job: Job = {
        index: nextIndex,
        urgent: false,
        controller,
        promise,
        resolve: res,
        reject: rej,
        started: false,
      };

      this.jobQueue.push(job);
      queueChanged = true;
    }

    if (queueChanged) {
      this.sortQueue();
      this.drainQueue();
    }
  }

  private sortQueue(): void {
    // Sort queue: urgent jobs first, then by chunk index
    this.jobQueue.sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return a.index - b.index;
    });
  }

  private drainQueue(): void {
    while (this.activeWorkers < this.maxConcurrent && this.jobQueue.length > 0) {
      const job = this.jobQueue.shift()!;
      this.activeWorkers++;
      this.inFlightJobs.set(job.index, job);
      job.started = true;

      this.executeJob(job).finally(() => {
        this.activeWorkers--;
        this.inFlightJobs.delete(job.index);
        this.drainQueue();
      });
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const chunkIndex = job.index;
    const byteOffset = chunkIndex * CHUNK_SIZE;
    const alignedOffset = Math.floor(byteOffset / 4096) * 4096;
    const alignedLimit = CHUNK_SIZE;
    const offsetBig = helpers.returnBigInt(alignedOffset);

    const client = getTelegramClient();
    if (!client) {
      job.reject(new Error('Telegram client is disconnected'));
      return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      if (job.controller.signal.aborted) {
        job.reject(new Error('Operation aborted'));
        return;
      }

      try {
        const sender = await (client as any).getSender(this.dcId);
        const req = new Api.upload.GetFile({
          location: this.location,
          offset: offsetBig,
          limit: alignedLimit,
          precise: true,
        });

        const abortPromise = new Promise<never>((_, reject) => {
          if (job.controller.signal.aborted) {
            reject(new Error('Operation aborted (seek)'));
          } else {
            job.controller.signal.addEventListener('abort', () => reject(new Error('Operation aborted (seek)')), { once: true });
          }
        });

        const result = await Promise.race([
          (client as any).invokeWithSender(req, sender),
          abortPromise,
        ]);

        if (result instanceof Api.upload.File) {
          const u8 = new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);

          // Update RAM & Dexie
          this.touchRam(chunkIndex, u8);
          this.downloadedChunks.add(chunkIndex);

          const record: VideoChunkRecord = {
            id: `${this.streamId}_${chunkIndex}`,
            streamId: this.streamId,
            chunkIndex,
            data: u8,
            byteLength: u8.byteLength,
            createdAt: Date.now(),
          };
          streamDb.videoChunks.put(record).catch(() => {});

          job.resolve(u8);
          return;
        }

        throw new Error('Empty file response from Telegram MTProto');
      } catch (err: any) {
        const msg = err.errorMessage || err.message || '';

        // Handle DC Migration
        if (msg.startsWith('FILE_MIGRATE_') || err instanceof errors.FileMigrateError) {
          const newDc = err.newDc || parseInt(msg.replace('FILE_MIGRATE_', ''), 10);
          if (newDc) {
            this.dcId = newDc;
            continue;
          }
        }

        // Handle File Reference Expiry
        if (msg.includes('FILE_REFERENCE_EXPIRED') || msg.includes('FILE_REFERENCE_')) {
          console.warn('File reference expired in TgFile, refreshing...');
          await this.refreshDocument(client);
          continue;
        }

        if (attempt === 2) {
          job.reject(err);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  private async refreshDocument(client: any): Promise<void> {
    try {
      let peer: any;
      try {
        peer = await client.getInputEntity(this.chatId);
      } catch {
        peer = this.chatId;
      }
      const msgs = await client.getMessages(peer, { ids: [this.messageId] });
      if (msgs && msgs[0]?.media instanceof Api.MessageMediaDocument) {
        const fresh = msgs[0].media.document;
        if (fresh instanceof Api.Document) {
          this.doc = fresh;
          this.location = new Api.InputDocumentFileLocation({
            id: fresh.id,
            accessHash: fresh.accessHash,
            fileReference: fresh.fileReference,
            thumbSize: '',
          });
        }
      }
    } catch (e) {
      console.warn('Failed to refresh document reference in TgFile:', e);
    }
  }

  /**
   * Pre-warms container header and tail chunks before user clicks Play.
   */
  public warmUp(): void {
    // 1. Header (Chunk 0, Chunk 1)
    this.getChunk(0, true).catch(() => {});
    if (this.totalChunks > 1) {
      this.getChunk(1, false).catch(() => {});
    }

    // 2. Tail chunk (moov / Cues)
    if (this.totalChunks > 2) {
      this.getChunk(this.totalChunks - 1, true).catch(() => {});
    }

    // 3. Speculative lookahead chunk 2
    if (this.totalChunks > 3) {
      this.getChunk(2, false).catch(() => {});
    }
  }

  /**
   * Seek cancellation: Aborts all non-urgent pending downloads outside [firstChunk, lastChunk].
   * Immediately frees worker slots for the new seek position.
   */
  public dropFarJobs(firstChunk: number, lastChunk: number): void {
    // Abort queued jobs outside window
    this.jobQueue = this.jobQueue.filter((job) => {
      if (this.pinnedChunks.has(job.index)) return true;
      if (job.index < firstChunk || job.index > lastChunk + 6) {
        job.controller.abort();
        job.reject(new Error('Operation aborted (seek)'));
        return false;
      }
      return true;
    });

    // Abort in-flight non-urgent jobs outside window
    for (const [chunkIdx, job] of this.inFlightJobs.entries()) {
      if (!this.pinnedChunks.has(chunkIdx) && !job.urgent) {
        if (chunkIdx < firstChunk || chunkIdx > lastChunk + 6) {
          job.controller.abort();
          this.inFlightJobs.delete(chunkIdx);
        }
      }
    }
  }

  private touchRam(chunkIndex: number, data: Uint8Array): void {
    if (this.ramCache.has(chunkIndex)) {
      this.ramCache.delete(chunkIndex);
    } else if (this.ramCache.size >= this.maxRamChunks) {
      // Find oldest unpinned chunk to evict
      for (const [key] of this.ramCache.entries()) {
        if (!this.pinnedChunks.has(key)) {
          this.ramCache.delete(key);
          break;
        }
      }
    }
    this.ramCache.set(chunkIndex, data);
  }

  public isChunkBuffered(chunkIndex: number): boolean {
    return this.ramCache.has(chunkIndex) || this.downloadedChunks.has(chunkIndex);
  }

  public getDownloadedChunks(): number[] {
    return Array.from(this.downloadedChunks).sort((a, b) => a - b);
  }
}

// Global Registry of active TgFiles
const activeFiles = new Map<string, TgFile>();

export function getOrCreateTgFile(options: TgFileOptions): TgFile {
  let file = activeFiles.get(options.streamId);
  if (!file) {
    file = new TgFile(options);
    activeFiles.set(options.streamId, file);
  }
  return file;
}

export function getActiveTgFile(streamId: string): TgFile | undefined {
  return activeFiles.get(streamId);
}

