import { Api, helpers, errors } from 'telegram';
import { getTelegramClient } from './telegram';
import { streamDb, CHUNK_SIZE, enforceActiveStreamCache, evictChunksOutsideWindow, type VideoChunkRecord, type StreamDescriptorRecord } from '../db/streamDb';
import { mergeRanges, isPinnedChunk, planSymmetricRingBuffer, type ByteRange } from './windowPlanner';
import { getOrCreateTgFile, getActiveTgFile, TgFile } from './stream/tgFile';

export interface TelemetryEvent {
  speedBytesPerSec: number;
  downloadedRanges: ByteRange[];
  isStalled: boolean;
  activeChunkIndex: number;
}

export type TelemetryListener = (event: TelemetryEvent) => void;

interface ActiveStreamMetadata {
  streamId: string;
  chatId: string;
  messageId: number;
  doc: Api.Document;
  location: Api.InputDocumentFileLocation;
  totalSize: number;
  totalChunks: number;
  mimeType: string;
  fileName: string;
  dcId: number;
}

export class TgStreamEngine {
  private static instance: TgStreamEngine | null = null;

  // L1 RAM Cache (max 64 chunks * 512KB = 32 MB)
  private memoryCache = new Map<string, Uint8Array>();
  private readonly maxMemoryChunks = 64;

  // In-flight deduplication
  private inFlightPromises = new Map<string, Promise<Uint8Array>>();

  // Active Stream Metadata
  private activeStream: ActiveStreamMetadata | null = null;
  private activeTgFile: TgFile | null = null;
  private activePrefetchControllers: AbortController[] = [];

  // Telemetry
  private telemetryListeners = new Set<TelemetryListener>();
  private speedWindowBytes: { bytes: number; timestamp: number }[] = [];
  private downloadedChunksSet = new Set<number>();
  private lastActivityTimestamp = Date.now();
  private telemetryInterval: any = null;

  // BroadcastChannel for Service Worker RPC
  private rpcChannel: BroadcastChannel | null = null;

  private constructor() {
    this.initRpcChannel();
    this.startTelemetryLoop();
  }

  public static getInstance(): TgStreamEngine {
    if (!TgStreamEngine.instance) {
      TgStreamEngine.instance = new TgStreamEngine();
    }
    return TgStreamEngine.instance;
  }

  private initRpcChannel(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.rpcChannel = new BroadcastChannel('tg-stream-rpc');
        this.rpcChannel.onmessage = async (event) => {
          const { type, requestId, streamId, chunkIndex } = event.data || {};
          if (type === 'REQUEST_DESCRIPTOR' && requestId && streamId) {
            try {
              let desc: any = null;
              if (this.activeStream && this.activeStream.streamId === streamId) {
                desc = {
                  streamId: this.activeStream.streamId,
                  totalSize: this.activeStream.totalSize,
                  mimeType: this.activeStream.mimeType,
                };
              } else {
                desc = await streamDb.streamDescriptors.get(streamId);
              }
              this.rpcChannel?.postMessage({
                type: 'DESCRIPTOR_RESPONSE',
                requestId,
                data: desc,
              });
            } catch (err: any) {
              this.rpcChannel?.postMessage({
                type: 'DESCRIPTOR_RESPONSE',
                requestId,
                error: err.message,
              });
            }
            return;
          }

          if (type === 'REQUEST_CHUNK' && requestId && streamId !== undefined && chunkIndex !== undefined) {
            try {
              const chunk = await this.getChunk(streamId, chunkIndex);
              this.rpcChannel?.postMessage({
                type: 'CHUNK_RESPONSE',
                requestId,
                data: chunk,
              });
            } catch (err: any) {
              this.rpcChannel?.postMessage({
                type: 'CHUNK_RESPONSE',
                requestId,
                error: err.message || 'Failed to fetch chunk',
              });
            }
          }
        };
      } catch (e) {
        console.warn('Failed to bind BroadcastChannel for tg-stream-rpc:', e);
      }
    }

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', async (event) => {
        if (event.origin && event.origin !== window.location.origin) return;
        const { type, requestId, streamId, chunkIndex } = event.data || {};
        if (type === 'REQUEST_CHUNK' && event.ports && event.ports[0]) {
          const port = event.ports[0];
          if (typeof chunkIndex !== 'number' || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
            port.postMessage({ type: 'CHUNK_RESPONSE', requestId, error: 'Invalid chunk index' });
            return;
          }
          try {
            const chunk = await this.getChunk(streamId, chunkIndex);
            port.postMessage({ type: 'CHUNK_RESPONSE', requestId, data: chunk });
          } catch (err: any) {
            port.postMessage({ type: 'CHUNK_RESPONSE', requestId, error: err.message || 'Chunk error' });
          }
        }
      });
    }
  }

  /**
   * Registers a new stream descriptor and sets it as the active watch session.
   */
  public async registerStream(
    chatId: string,
    messageId: number,
    doc: Api.Document,
    fileName: string,
    mimeType: string
  ): Promise<string> {
    const streamId = `${chatId}_${messageId}`;
    const totalSize = Number(doc.size);
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const dcId = doc.dcId || 1;

    const location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    });

    this.activeStream = {
      streamId,
      chatId,
      messageId,
      doc,
      location,
      totalSize,
      totalChunks,
      mimeType: mimeType || doc.mimeType || 'video/mp4',
      fileName,
      dcId,
    };

    // Single-Video Cache Enforcer: clean up non-active video chunks
    await enforceActiveStreamCache(streamId);

    // Persist descriptor in Dexie for Service Worker lookups
    const descriptor: StreamDescriptorRecord = {
      streamId,
      chatId,
      messageId,
      fileName,
      mimeType: this.activeStream.mimeType,
      totalSize,
      dcId,
      updatedAt: Date.now(),
    };
    await streamDb.streamDescriptors.put(descriptor);

    // Seed downloaded chunks set from Dexie
    const existing = await streamDb.videoChunks.where('streamId').equals(streamId).toArray();
    this.downloadedChunksSet.clear();
    for (const rec of existing) {
      this.downloadedChunksSet.add(rec.chunkIndex);
    }

    // Initialize unified virtual TgFile (TMPlayer architecture)
    this.activeTgFile = getOrCreateTgFile({
      streamId,
      chatId,
      messageId,
      doc,
      totalSize,
      dcId,
      mimeType: this.activeStream.mimeType,
      fileName,
    });

    this.abortPrefetches();
    return streamId;
  }

  /**
   * Pre-warms container header and trailer chunks as soon as user opens video detail modal.
   */
  public async warmFile(
    chatId: string,
    messageId: number,
    doc: Api.Document,
    fileName: string,
    mimeType: string
  ): Promise<void> {
    const streamId = `${chatId}_${messageId}`;
    const file = getOrCreateTgFile({
      streamId,
      chatId,
      messageId,
      doc,
      totalSize: Number(doc.size),
      dcId: doc.dcId || 1,
      mimeType: mimeType || doc.mimeType || 'video/mp4',
      fileName,
    });
    file.warmUp();
  }

  /**
   * Resolves or refreshes document metadata if file reference expires.
   */
  private async refreshDocument(): Promise<void> {
    if (!this.activeStream) return;
    const client = getTelegramClient();
    if (!client) throw new Error('Telegram client not initialized');

    try {
      let peer: any;
      try {
        peer = await client.getInputEntity(this.activeStream.chatId);
      } catch {
        peer = this.activeStream.chatId;
      }

      const msgs = await client.getMessages(peer, { ids: [this.activeStream.messageId] });
      if (msgs && msgs[0]?.media instanceof Api.MessageMediaDocument) {
        const freshDoc = msgs[0].media.document;
        if (freshDoc instanceof Api.Document) {
          this.activeStream.doc = freshDoc;
          this.activeStream.location = new Api.InputDocumentFileLocation({
            id: freshDoc.id,
            accessHash: freshDoc.accessHash,
            fileReference: freshDoc.fileReference,
            thumbSize: '',
          });
        }
      }
    } catch (e) {
      console.error('Failed to auto-refresh expired file reference:', e);
      throw e;
    }
  }

  /**
   * Retrieve chunk with 3-level caching (RAM -> IndexedDB -> GramJS MTProto).
   */
  public async getChunk(
    streamId: string,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    // Fast-path: Unified virtual TgFile (parallel 4-worker pipeline)
    let tgFile = this.activeTgFile;
    if (!tgFile || tgFile.streamId !== streamId) {
      const existing = getActiveTgFile(streamId);
      if (existing) {
        tgFile = existing;
        this.activeTgFile = existing;
      }
    }

    if (tgFile && tgFile.streamId === streamId) {
      const u8 = await tgFile.getChunk(chunkIndex, true);
      this.recordBytesReceived(u8.byteLength);
      this.downloadedChunksSet.add(chunkIndex);
      return u8;
    }

    const chunkKey = `${streamId}_${chunkIndex}`;

    // Level 1: In-Memory RAM LRU
    const ramChunk = this.memoryCache.get(chunkKey);
    if (ramChunk) {
      this.touchRamCache(chunkKey, ramChunk);
      return ramChunk;
    }

    // Level 2: Dexie IndexedDB
    try {
      const dbRecord = await streamDb.videoChunks.get(chunkKey);
      if (dbRecord && dbRecord.data) {
        this.touchRamCache(chunkKey, dbRecord.data);
        this.downloadedChunksSet.add(chunkIndex);
        return dbRecord.data;
      }
    } catch (e) {
      console.warn('IndexedDB read error for chunk:', chunkKey, e);
    }

    // Level 3: In-flight deduplication
    const existingPromise = this.inFlightPromises.get(chunkKey);
    if (existingPromise) {
      return existingPromise;
    }

    // Trigger MTProto Download
    const downloadPromise = this.downloadChunkFromTelegram(streamId, chunkIndex, signal);
    this.inFlightPromises.set(chunkKey, downloadPromise);

    try {
      const data = await downloadPromise;
      return data;
    } finally {
      this.inFlightPromises.delete(chunkKey);
    }
  }

  private async downloadChunkFromTelegram(
    streamId: string,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!this.activeStream || this.activeStream.streamId !== streamId) {
      const desc = await streamDb.streamDescriptors.get(streamId);
      if (!desc) {
        throw new Error(`Stream ${streamId} not found`);
      }
    }

    const client = getTelegramClient();
    if (!client) {
      throw new Error('Telegram client is disconnected');
    }

    const byteOffset = chunkIndex * CHUNK_SIZE;
    const alignedOffset = Math.floor(byteOffset / 4096) * 4096;
    const alignedLimit = CHUNK_SIZE; // strictly 512 KB (divides 1MB evenly)
    const offsetBig = helpers.returnBigInt(alignedOffset);

    let dcId = this.activeStream?.dcId || 1;
    let location = this.activeStream?.location;

    if (!location) {
      throw new Error('Active stream document location missing');
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) {
        throw new Error('Chunk download aborted by signal');
      }

      try {
        const sender = await (client as any).getSender(dcId);
        const req = new Api.upload.GetFile({
          location,
          offset: offsetBig,
          limit: alignedLimit,
          precise: true,
        });

        const result = await (client as any).invokeWithSender(req, sender);

        if (result instanceof Api.upload.File) {
          const u8 = new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);

          // Update telemetry
          this.recordBytesReceived(u8.byteLength);
          this.downloadedChunksSet.add(chunkIndex);

          // Store in L1 RAM
          const chunkKey = `${streamId}_${chunkIndex}`;
          this.touchRamCache(chunkKey, u8);

          // Store in L2 Dexie IndexedDB
          const record: VideoChunkRecord = {
            id: chunkKey,
            streamId,
            chunkIndex,
            data: u8,
            byteLength: u8.byteLength,
            createdAt: Date.now(),
          };
          streamDb.videoChunks.put(record).catch(() => {});

          // Trigger Smart Read-Ahead Prefetch
          this.schedulePrefetch(streamId, chunkIndex);

          return u8;
        }

        throw new Error('Empty file response from Telegram MTProto');
      } catch (err: any) {
        const msg = err.errorMessage || err.message || '';

        // Handle DC Migration
        if (msg.startsWith('FILE_MIGRATE_') || err instanceof errors.FileMigrateError) {
          const newDc = err.newDc || parseInt(msg.replace('FILE_MIGRATE_', ''), 10);
          if (newDc) {
            dcId = newDc;
            if (this.activeStream) this.activeStream.dcId = newDc;
            continue;
          }
        }

        // Handle File Reference Expiry
        if (msg.includes('FILE_REFERENCE_EXPIRED') || msg.includes('FILE_REFERENCE_')) {
          console.warn('File reference expired mid-stream, refreshing...');
          await this.refreshDocument();
          location = this.activeStream!.location;
          continue;
        }

        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    throw new Error(`Failed to download chunk ${chunkIndex} after 3 attempts`);
  }

  /**
   * Smart Read-Ahead Prefetcher:
   * End-of-file probe detection: do NOT prefetch forward on moov/Cues jump.
   * Otherwise queues +1, +2, +3 background chunks.
   */
  private schedulePrefetch(streamId: string, currentChunkIndex: number): void {
    if (!this.activeStream || this.activeStream.streamId !== streamId) return;

    const totalChunks = this.activeStream.totalChunks;

    // End-of-file container probe check (moov / Cues table jump)
    if (totalChunks > 3 && currentChunkIndex >= totalChunks - 3) {
      // Do not prefetch forward from trailer atom!
      return;
    }

    // Prefetch up to 3 chunks ahead (concurrency limit: 2)
    const targets = [currentChunkIndex + 1, currentChunkIndex + 2, currentChunkIndex + 3].filter(
      (c) => c < totalChunks && !this.downloadedChunksSet.has(c)
    );

    for (const target of targets.slice(0, 2)) {
      const chunkKey = `${streamId}_${target}`;
      if (this.memoryCache.has(chunkKey) || this.inFlightPromises.has(chunkKey)) continue;

      const controller = new AbortController();
      this.activePrefetchControllers.push(controller);

      this.getChunk(streamId, target, controller.signal).catch(() => {});
    }
  }

  public abortPrefetches(): void {
    for (const ctrl of this.activePrefetchControllers) {
      ctrl.abort();
    }
    this.activePrefetchControllers = [];
  }

  private touchRamCache(key: string, data: Uint8Array): void {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    } else if (this.memoryCache.size >= this.maxMemoryChunks) {
      const oldest = this.memoryCache.keys().next().value;
      if (oldest) this.memoryCache.delete(oldest);
    }
    this.memoryCache.set(key, data);
  }

  private recordBytesReceived(bytes: number): void {
    const now = Date.now();
    this.lastActivityTimestamp = now;
    this.speedWindowBytes.push({ bytes, timestamp: now });
  }

  private startTelemetryLoop(): void {
    this.telemetryInterval = setInterval(() => {
      const now = Date.now();
      // Keep entries within last 1500 ms
      this.speedWindowBytes = this.speedWindowBytes.filter((e) => now - e.timestamp <= 1500);

      const totalWindowBytes = this.speedWindowBytes.reduce((s, e) => s + e.bytes, 0);
      const speedBytesPerSec = Math.round(totalWindowBytes / 1.5);
      const isStalled = now - this.lastActivityTimestamp > 6000 && this.inFlightPromises.size > 0;

      // Calculate downloaded byte ranges
      const sortedChunks = Array.from(this.downloadedChunksSet).sort((a, b) => a - b);
      const rawRanges: ByteRange[] = [];
      for (const c of sortedChunks) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, this.activeStream?.totalSize || start + CHUNK_SIZE);
        rawRanges.push({ start, end });
      }
      const downloadedRanges = mergeRanges(rawRanges);

      const event: TelemetryEvent = {
        speedBytesPerSec,
        downloadedRanges,
        isStalled,
        activeChunkIndex: sortedChunks.length > 0 ? sortedChunks[sortedChunks.length - 1] : 0,
      };

      for (const listener of this.telemetryListeners) {
        listener(event);
      }
    }, 500);
  }

  public subscribeTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  /**
   * Pipelined concurrent chunk fetcher (concurrency = 3).
   * Saturates available bandwidth and eliminates MTProto RTT latency between sequential chunks.
   */
  public async fetchChunksConcurrently(
    streamId: string,
    chunks: number[],
    concurrency = 3,
    onChunkDone?: (chunkIndex: number, completedCount: number) => void
  ): Promise<void> {
    const queue = [...chunks];
    let completed = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        try {
          await this.getChunk(streamId, next);
        } catch (e) {
          console.warn(`Concurrent chunk ${next} fetch warning:`, e);
        }
        completed++;
        onChunkDone?.(next, completed);
      }
    });
    await Promise.all(workers);
  }

  /**
   * Fast-Start Pre-roll Buffer:
   * Loads container header (chunks 0..1) + nimble 3-chunk playhead burst (~1.5 MB).
   * Starts playback in 1-2 seconds even on slow internet, then streams the remaining forward 30s in the background.
   */
  public async preloadInitialBuffer(
    streamId: string,
    initialTimeSec: number = 0,
    durationSec: number = 0,
    onProgress?: (percent: number, speedBytesPerSec: number, status: string) => void
  ): Promise<void> {
    if (!this.activeStream || this.activeStream.streamId !== streamId) {
      const desc = await streamDb.streamDescriptors.get(streamId);
      if (!desc) {
        throw new Error(`Stream descriptor ${streamId} not found in database`);
      }
    }

    const totalSize = this.activeStream?.totalSize || 0;
    const plan = planSymmetricRingBuffer(initialTimeSec, durationSec, totalSize);

    // Fast-Start targets:
    // 1. Pinned headers: chunks 0..1
    // 2. Playhead burst: up to 3 chunks around current playhead
    const headerChunks = plan.pinnedChunks.slice(0, 2);
    const playheadBurst: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = plan.currentChunk + i;
      if (c < (this.activeStream?.totalChunks || 1) && !headerChunks.includes(c)) {
        playheadBurst.push(c);
      }
    }

    const fastStartChunks = Array.from(new Set([...headerChunks, ...playheadBurst]));
    const totalToLoad = Math.max(1, fastStartChunks.length);

    onProgress?.(10, 0, 'Connecting to Telegram MTProto...');

    await this.fetchChunksConcurrently(
      streamId,
      fastStartChunks,
      3,
      (_chunkIdx, completedCount) => {
        const pct = Math.min(100, Math.round((completedCount / totalToLoad) * 100));
        const lastSpeed = this.getCurrentSpeed();
        onProgress?.(pct, lastSpeed, `Buffering initial burst (${pct}%)...`);
      }
    );

    onProgress?.(100, this.getCurrentSpeed(), 'Playback ready');

    // Asynchronously prefetch remaining 30s forward chunks in background without blocking player launch
    const backgroundTargets = plan.chunksToPreload.slice(0, 8).filter((c) => !this.downloadedChunksSet.has(c));
    if (backgroundTargets.length > 0) {
      this.fetchChunksConcurrently(streamId, backgroundTargets, 2).catch(() => {});
    }
  }

  public getCurrentSpeed(): number {
    const now = Date.now();
    const recent = this.speedWindowBytes.filter((e) => now - e.timestamp <= 1500);
    const sum = recent.reduce((s, e) => s + e.bytes, 0);
    return Math.round(sum / 1.5);
  }

  public isTimeBuffered(timeSec: number, durationSec: number): boolean {
    if (!this.activeStream) return false;
    const totalSize = this.activeStream.totalSize;
    if (totalSize <= 0) return false;
    let byteOffset = 0;
    if (durationSec > 0) {
      const ratio = Math.max(0, Math.min(1, timeSec / durationSec));
      byteOffset = Math.floor(ratio * totalSize);
    }
    const chunkIndex = Math.floor(byteOffset / CHUNK_SIZE);
    return (
      this.downloadedChunksSet.has(chunkIndex) ||
      this.memoryCache.has(`${this.activeStream.streamId}_${chunkIndex}`)
    );
  }

  /**
   * Recenter 1-minute rolling buffer [target - 30s, target + 30s] on user seek / jump.
   * Evicts chunks outside window from RAM and IndexedDB, and downloads forward from target chunk.
   * NEVER downloads from 0s to target point!
   */
  public recenterRingBuffer(streamId: string, targetTimeSec: number, durationSec: number): void {
    if (!this.activeStream || this.activeStream.streamId !== streamId) return;
    this.abortPrefetches();

    const plan = planSymmetricRingBuffer(targetTimeSec, durationSec, this.activeStream.totalSize);

    // Abort pending jobs outside new seek window in TgFile
    this.activeTgFile?.dropFarJobs(plan.startChunk, plan.endChunk);

    // Evict chunks outside active [startChunk, endChunk] from RAM cache
    const pinnedSet = new Set(plan.pinnedChunks);
    for (const key of Array.from(this.memoryCache.keys())) {
      if (key.startsWith(`${streamId}_`)) {
        const cIdx = parseInt(key.replace(`${streamId}_`, ''), 10);
        if (!pinnedSet.has(cIdx) && (cIdx < plan.startChunk || cIdx > plan.endChunk)) {
          this.memoryCache.delete(key);
          this.downloadedChunksSet.delete(cIdx);
        }
      }
    }

    // Evict from IndexedDB in background
    evictChunksOutsideWindow(streamId, plan.startChunk, plan.endChunk, plan.pinnedChunks).catch(() => {});

    // Fetch forward chunks starting at targetChunk immediately
    const toFetch = plan.chunksToPreload.slice(0, 4).filter((c) => !this.downloadedChunksSet.has(c));
    for (const c of toFetch) {
      const controller = new AbortController();
      this.activePrefetchControllers.push(controller);
      this.getChunk(streamId, c, controller.signal).catch(() => {});
    }
  }

  /**
   * Periodic pruning during active playback: keeps only the current 1-minute window
   * [current - 30s, current + 30s] in RAM and IndexedDB.
   */
  public pruneCacheWindow(currentTimeSec: number, durationSec: number): void {
    if (!this.activeStream) return;
    const plan = planSymmetricRingBuffer(currentTimeSec, durationSec, this.activeStream.totalSize);
    const pinnedSet = new Set(plan.pinnedChunks);

    // Prune RAM
    for (const key of Array.from(this.memoryCache.keys())) {
      if (key.startsWith(`${this.activeStream.streamId}_`)) {
        const cIdx = parseInt(key.replace(`${this.activeStream.streamId}_`, ''), 10);
        if (!pinnedSet.has(cIdx) && (cIdx < plan.startChunk || cIdx > plan.endChunk)) {
          this.memoryCache.delete(key);
          this.downloadedChunksSet.delete(cIdx);
        }
      }
    }

    // Prune IndexedDB
    evictChunksOutsideWindow(this.activeStream.streamId, plan.startChunk, plan.endChunk, plan.pinnedChunks).catch(() => {});
  }

  public destroy(): void {
    this.abortPrefetches();
    if (this.telemetryInterval) clearInterval(this.telemetryInterval);
    this.rpcChannel?.close();
  }
}

export const tgStreamEngine = TgStreamEngine.getInstance();

