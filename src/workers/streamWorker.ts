/**
 * Dedicated Web Worker for segment-based MTProto chunk fetching,
 * EBML demuxing, and fMP4 transmuxing off the main thread.
 */

import { DownloadWindow, TELEGRAM_ALIGNMENT } from '../services/downloadWindow.ts';
import {
  parseMatroskaHeader,
  parseCues,
  findNextCluster,
  readElementId,
  readDataSize,
  parseClusterPayload,
  EBML_ID,
  type MatroskaMetadata,
  type CueEntry,
  type ParsedBlock,
} from '../services/remuxer/ebml.ts';
import { MatroskaTransmuxer } from '../services/remuxer/transmuxer.ts';

// Helper for worker postMessage with transferables in TS DOM lib
function postWorkerMessage(msg: any, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as any).postMessage(msg, transfer);
  } else {
    (self as any).postMessage(msg);
  }
}

interface FetchRequestRecord {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timer: any;
}

let cachedWorkerDb: IDBDatabase | null = null;

async function getWorkerDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (cachedWorkerDb) return cachedWorkerDb;

  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('StreamUpMediaDB', 1);
      req.onsuccess = () => {
        cachedWorkerDb = req.result;
        cachedWorkerDb.onversionchange = () => {
          cachedWorkerDb?.close();
          cachedWorkerDb = null;
        };
        cachedWorkerDb.onerror = () => {
          cachedWorkerDb?.close();
          cachedWorkerDb = null;
        };
        resolve(cachedWorkerDb);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function getChunkFromIndexedDB(streamId: string, chunkIndex: number): Promise<ArrayBuffer | null> {
  const db = await getWorkerDb();
  if (!db || !db.objectStoreNames.contains('videoChunks')) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('videoChunks', 'readonly');
      const store = tx.objectStore('videoChunks');
      const getReq = store.get(`${streamId}_${chunkIndex}`);
      getReq.onsuccess = () => {
        if (getReq.result && getReq.result.data) {
          const u8 = getReq.result.data;
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          resolve(ab);
        } else {
          resolve(null);
        }
      };
      getReq.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

class ChunkFetcher {
  private channel: BroadcastChannel | null = null;
  private pendingRequests = new Map<string, FetchRequestRecord>();
  private prefetchMap = new Map<string, Promise<Uint8Array>>();
  private requestCounter = 0;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('tg-stream-rpc');
        this.channel.onmessage = (event) => this.handleMessage(event.data);
      } catch (e) {
        console.warn('Worker BroadcastChannel error:', e);
      }
    }
  }

  public handleMessage(data: any): void {
    if (!data || !data.requestId) return;
    const pending = this.pendingRequests.get(data.requestId);
    if (!pending) return;

    this.pendingRequests.delete(data.requestId);
    clearTimeout(pending.timer);

    if (data.type === 'CHUNK_RESPONSE' || data.type === 'FETCH_CHUNK_RESPONSE') {
      if (data.error) {
        pending.reject(new Error(data.error));
      } else if (data.data) {
        if (data.data instanceof Uint8Array) {
          pending.resolve(data.data.buffer.slice(data.data.byteOffset, data.data.byteOffset + data.data.byteLength));
        } else if (data.data.buffer instanceof ArrayBuffer) {
          pending.resolve(data.data.buffer);
        } else if (data.data instanceof ArrayBuffer) {
          pending.resolve(data.data);
        } else {
          pending.reject(new Error('Unrecognized chunk buffer format'));
        }
      } else {
        pending.reject(new Error('Empty buffer received'));
      }
    }
  }

  public async fetchChunkByIndex(streamId: string, chunkIndex: number, timeoutMs = 25000): Promise<Uint8Array> {
    const cacheKey = `${streamId}_${chunkIndex}`;
    const cached = this.prefetchMap.get(cacheKey);
    if (cached) {
      try {
        return await cached;
      } catch {
        this.prefetchMap.delete(cacheKey);
      }
    }

    // 1. Direct IndexedDB check first (0ms)
    const dbBuf = await getChunkFromIndexedDB(streamId, chunkIndex);
    if (dbBuf && dbBuf.byteLength > 0) {
      const u8 = new Uint8Array(dbBuf);
      this.prefetchMap.set(cacheKey, Promise.resolve(u8));
      return u8;
    }

    // 2. Request from tgStreamEngine via tg-stream-rpc
    const requestId = `wrk_${++this.requestCounter}_${Date.now()}`;
    const fetchPromise = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.prefetchMap.delete(cacheKey);
        reject(new Error(`Chunk fetch timeout for chunk ${chunkIndex}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (ab: ArrayBuffer) => {
          const u8 = new Uint8Array(ab);
          this.prefetchMap.set(cacheKey, Promise.resolve(u8));
          resolve(u8);
        },
        reject: (err: Error) => {
          this.prefetchMap.delete(cacheKey);
          reject(err);
        },
        timer,
      });

      if (this.channel) {
        this.channel.postMessage({
          type: 'REQUEST_CHUNK',
          requestId,
          streamId,
          chunkIndex,
        });
      } else {
        postWorkerMessage({
          type: 'DELEGATE_REQUEST_CHUNK',
          requestId,
          streamId,
          chunkIndex,
        });
      }
    });

    this.prefetchMap.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  public prefetchAhead(streamId: string, currentChunk: number, aheadCount = 3): void {
    const CHUNK_SIZE = 512 * 1024;
    for (let i = 1; i <= aheadCount; i++) {
      const targetChunk = currentChunk + i;
      if (totalFileSize > 0 && targetChunk * CHUNK_SIZE >= totalFileSize) break;
      const key = `${streamId}_${targetChunk}`;
      if (!this.prefetchMap.has(key)) {
        this.fetchChunkByIndex(streamId, targetChunk).catch(() => {
          this.prefetchMap.delete(key);
        });
      }
    }

    // Bound in-memory cache to prevent memory bloat (max 12 chunks)
    if (this.prefetchMap.size > 12) {
      for (const [key] of this.prefetchMap) {
        const parts = key.split('_');
        const idx = Number(parts[parts.length - 1]);
        if (idx < currentChunk - 1) {
          this.prefetchMap.delete(key);
        }
      }
    }
  }

  public async fetch(
    channelId: string,
    messageId: string | number,
    offset: number,
    limit: number,
    timeoutMs = 25000
  ): Promise<ArrayBuffer> {
    const streamId = `${channelId}_${messageId}`;
    const CHUNK_SIZE = 512 * 1024;
    const startChunk = Math.floor(offset / CHUNK_SIZE);
    const endChunk = Math.floor((offset + limit - 1) / CHUNK_SIZE);

    if (startChunk === endChunk) {
      const chunkData = await this.fetchChunkByIndex(streamId, startChunk, timeoutMs);
      const chunkStart = startChunk * CHUNK_SIZE;
      const sliceStart = Math.max(0, offset - chunkStart);
      const sliceEnd = Math.min(chunkData.byteLength, sliceStart + limit);
      const slice = chunkData.subarray(sliceStart, sliceEnd);
      const out = new Uint8Array(slice.byteLength);
      out.set(slice);
      return out.buffer;
    }

    // Spans across multiple 512KB chunks
    const totalResult = new Uint8Array(limit);
    let written = 0;

    for (let c = startChunk; c <= endChunk && written < limit; c++) {
      const chunkData = await this.fetchChunkByIndex(streamId, c, timeoutMs);
      const chunkStart = c * CHUNK_SIZE;
      const sliceStart = Math.max(0, offset - chunkStart);
      const needed = limit - written;
      const available = chunkData.byteLength - sliceStart;
      if (available <= 0) break;
      const take = Math.min(needed, available);
      totalResult.set(chunkData.subarray(sliceStart, sliceStart + take), written);
      written += take;
    }

    const finalResult = written === limit ? totalResult : totalResult.slice(0, written);
    return finalResult.buffer;
  }

  public abortAll(): void {
    this.prefetchMap.clear();
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('Operation aborted'));
    }
    this.pendingRequests.clear();
  }
}

// Worker State
let fetcher = new ChunkFetcher();
let downloadWindow: DownloadWindow | null = null;
let transmuxer: MatroskaTransmuxer | null = null;
let metadata: MatroskaMetadata | null = null;

let isRunning = false;
let isPaused = false;
let activeChannelId = '';
let activeMessageId: string | number = 0;
let totalFileSize = 0;
let mimeType = 'video/x-matroska';

let currentReadOffset = 0;
let activeLoopId = 0;
let currentPlayheadSec = 0;
let lastEmittedPtsSec = 0;
let isVideoPaused = false;
let isBufferFull = false;

// Sub-cluster streaming parser state
let inCluster = false;
let currentClusterTimeMs = 0;
let clusterPayloadRemaining = -1;

// Residual byte buffer for incomplete clusters across chunk boundaries
let clusterAccumulator: Uint8Array = new Uint8Array(0);

async function startStream(
  channelId: string,
  messageId: string | number,
  fileSize: number,
  type: string
) {
  isRunning = true;
  isPaused = false;
  isBufferFull = false;
  activeChannelId = channelId;
  activeMessageId = messageId;
  totalFileSize = fileSize;
  mimeType = type;
  activeLoopId++;
  const thisLoopId = activeLoopId;

  downloadWindow = new DownloadWindow(fileSize);
  currentReadOffset = 0;
  clusterAccumulator = new Uint8Array(0);
  inCluster = false;
  currentClusterTimeMs = 0;
  clusterPayloadRemaining = -1;

  try {
    postWorkerMessage({ type: 'STATUS', status: 'Fetching container header...' });

    // 1. Fetch initial header chunk (512 KB)
    const headerLimit = Math.min(512 * 1024, fileSize);
    const initialBuf = await fetcher.fetch(activeChannelId, activeMessageId, 0, headerLimit);
    if (thisLoopId !== activeLoopId) return;

    const initialU8 = new Uint8Array(initialBuf);
    downloadWindow.update(0, initialBuf.byteLength);

    // 2. Parse EBML Header & Tracks
    metadata = parseMatroskaHeader(initialU8);

    if (!metadata) {
      postWorkerMessage({
        type: 'ERROR',
        message: 'Could not demux Matroska header. File may not be MKV or corrupted.',
      });
      return;
    }

    // Check if Cues are present. If not, fetch last 512KB chunk to parse Cues from tail
    if (metadata.cues.length === 0 && fileSize > 1024 * 1024) {
      try {
        const tailChunkIndex = Math.max(0, Math.ceil(fileSize / (512 * 1024)) - 1);
        const tailOffset = tailChunkIndex * (512 * 1024);
        const tailLimit = Math.min(512 * 1024, fileSize - tailOffset);
        const tailBuf = await fetcher.fetch(
          activeChannelId,
          activeMessageId,
          tailOffset,
          tailLimit
        );
        if (thisLoopId === activeLoopId) {
          const tailU8 = new Uint8Array(tailBuf);
          // Scan for Cues ID in tail
          for (let i = 0; i < tailU8.length - 4; i++) {
            const el = readElementId(tailU8, i);
            if (el && el.value === EBML_ID.CUES) {
              const sz = readDataSize(tailU8, i + el.length);
              if (sz) {
                parseCues(tailU8, i + el.length + sz.length, sz.value, metadata.cues);
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Tail Cues fetch failed, falling back to hybrid index:', e);
      }
    }

    transmuxer = new MatroskaTransmuxer(metadata);

    const videoCodec = transmuxer.getVideoCodecString();
    const audioCodec = transmuxer.getAudioCodecString();
    const isAudioSupported = transmuxer.isAudioSupported();
    const audioCodecName = transmuxer.getAudioCodecName();

    postWorkerMessage({
      type: 'METADATA_LOADED',
      metadata: {
        docType: metadata.docType,
        durationSec: metadata.durationSec,
        cuesCount: metadata.cues.length,
      },
      videoCodec,
      audioCodec,
      isAudioSupported,
      audioCodecName,
      durationSec: metadata.durationSec,
    });

    // Check if init segment is ready right away
    const initSeg = transmuxer.generateInitSegment();
    if (initSeg) {
      postWorkerMessage(
        {
          type: 'INIT_SEGMENT',
          buffer: initSeg.buffer,
        },
        [initSeg.buffer]
      );
    }

    // 3. Locate first media cluster
    // Note: Bytes 0..headerLimit have already been fetched in Chunk 0.
    // currentReadOffset must be set to headerLimit so Chunk 0 is never re-fetched.
    const firstClusterRel = findNextCluster(initialU8, metadata.segmentDataOffset);
    if (firstClusterRel !== -1) {
      clusterAccumulator = initialU8.slice(firstClusterRel);
    } else {
      // If no cluster found in header chunk, retain trailing 3 bytes for boundary detection
      clusterAccumulator = initialU8.slice(Math.max(metadata.segmentDataOffset, headerLimit - 3));
    }
    currentReadOffset = headerLimit;

    // 4. Begin continuous segment-based streaming loop
    runStreamLoop(thisLoopId);
  } catch (err: any) {
    if (thisLoopId === activeLoopId) {
      postWorkerMessage({ type: 'ERROR', message: err.message || 'Stream initialization error' });
    }
  }
}

async function runStreamLoop(loopId: number) {
  const CHUNK_SIZE = 512 * 1024; // 512 KB per request
  const BUFFER_TARGET_SEC = 50; // Elastic buffer target up to 45-60s
  const BUFFER_RESUME_SEC = 35; // Hysteresis floor
  const LOW_WATERMARK_SEC = 10; // Low-watermark burst threshold

  while (isRunning && loopId === activeLoopId) {
    if (isPaused) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    const forwardBufferedSec = lastEmittedPtsSec > 0 ? (lastEmittedPtsSec - currentPlayheadSec) : 0;

    // Elastic buffer window with hysteresis:
    // Prevents frequent stop-and-go stall cycles by prefetching up to 50s and resuming at 35s
    if (isBufferFull) {
      if (forwardBufferedSec < BUFFER_RESUME_SEC) {
        isBufferFull = false;
      } else {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    } else if (lastEmittedPtsSec > 0 && forwardBufferedSec >= BUFFER_TARGET_SEC) {
      isBufferFull = true;
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    // Check if we have a full cluster / completed blocks in accumulator
    let handledCluster = processAccumulator(currentReadOffset >= totalFileSize);

    if (!handledCluster) {
      // Need more data from Telegram
      if (currentReadOffset >= totalFileSize) {
        if (processAccumulator(true)) {
          continue;
        }
        postWorkerMessage({ type: 'EOF' });
        break;
      }

      // Pipelined lookahead prefetching:
      // Low watermark (<10s) triggers aggressive burst prefetch (3 chunks ahead)
      const isLowWatermark = forwardBufferedSec < LOW_WATERMARK_SEC;
      const prefetchLookahead = isLowWatermark ? 3 : 2;
      const fetchOffset = DownloadWindow.alignOffset(currentReadOffset);
      const currentChunk = Math.floor(fetchOffset / CHUNK_SIZE);
      const streamId = `${activeChannelId}_${activeMessageId}`;

      fetcher.prefetchAhead(streamId, currentChunk, prefetchLookahead);

      const fetchSize = Math.min(CHUNK_SIZE, totalFileSize - fetchOffset);

      try {
        const chunkBuf = await fetcher.fetch(
          activeChannelId,
          activeMessageId,
          fetchOffset,
          fetchSize
        );
        if (loopId !== activeLoopId) break;

        const chunkU8 = new Uint8Array(chunkBuf);
        downloadWindow?.update(fetchOffset, chunkBuf.byteLength);

        // Append new bytes to cluster accumulator
        const combined = new Uint8Array(clusterAccumulator.length + chunkU8.length);
        combined.set(clusterAccumulator, 0);
        combined.set(chunkU8, clusterAccumulator.length);
        clusterAccumulator = combined;

        currentReadOffset = fetchOffset + chunkBuf.byteLength;
      } catch (err: any) {
        if (loopId === activeLoopId) {
          console.warn('Chunk fetch retry in 500ms:', err.message);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } else {
      // Yield to event loop to allow seek or pause messages
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/**
 * Inspects clusterAccumulator. Parses and transmuxes media blocks incrementally in sub-clusters.
 * Emits MEDIA_SEGMENT every ~8-15 blocks (~300-600ms) without waiting for entire 10-25 MB cluster completion.
 */
function processAccumulator(isEof = false): boolean {
  if (!transmuxer || clusterAccumulator.length === 0) return false;

  // 1. Locate next Cluster element if not currently in a cluster
  if (!inCluster) {
    if (clusterAccumulator.length < 12) return false;

    let clusterStart = 0;
    const el = readElementId(clusterAccumulator, clusterStart);
    if (!el || el.value !== EBML_ID.CLUSTER) {
      const nextIdx = findNextCluster(clusterAccumulator, 0);
      if (nextIdx === -1) {
        // Discard prefix bytes, keep trailing 3 for boundary detection
        if (clusterAccumulator.length > 3) {
          clusterAccumulator = clusterAccumulator.slice(clusterAccumulator.length - 3);
        }
        return false;
      }
      clusterStart = nextIdx;
    }

    const elHeader = readElementId(clusterAccumulator, clusterStart);
    if (!elHeader) return false;

    const sz = readDataSize(clusterAccumulator, clusterStart + elHeader.length);
    if (!sz) return false;

    const payloadStart = clusterStart + elHeader.length + sz.length;
    clusterAccumulator = clusterAccumulator.slice(payloadStart);
    inCluster = true;
    currentClusterTimeMs = 0;
    clusterPayloadRemaining = sz.value >= 0 ? sz.value : -1;
  }

  // 2. Check if next bytes in accumulator are the start of a subsequent Cluster
  if (clusterAccumulator.length >= 4) {
    const nextEl = readElementId(clusterAccumulator, 0);
    if (nextEl && nextEl.value === EBML_ID.CLUSTER) {
      inCluster = false;
      return true; // Re-enter to process next cluster header
    }
  }

  // 3. Incrementally parse completed blocks from current cluster payload
  const { clusterTimeMs, blocks, bytesConsumed } = parseClusterPayload(
    clusterAccumulator,
    currentClusterTimeMs
  );
  currentClusterTimeMs = clusterTimeMs;

  if (bytesConsumed > 0 && clusterPayloadRemaining > 0) {
    clusterPayloadRemaining = Math.max(0, clusterPayloadRemaining - bytesConsumed);
    if (clusterPayloadRemaining === 0) {
      inCluster = false;
    }
  }

  // Filter video blocks for emission threshold
  const videoTrackNum = transmuxer.getVideoTrackNumber();
  const videoBlocks = blocks.filter((b: ParsedBlock) => b.trackNumber === videoTrackNum);

  // Batch media segments into smooth increments (~1-2s / GOP boundaries) instead of emitting 8-frame micro-bursts,
  // while preserving fast initial startup (<4s forward buffer) and immediate EOF flushing.
  const forwardSec = lastEmittedPtsSec > 0 ? (lastEmittedPtsSec - currentPlayheadSec) : 0;
  const minBlocksThreshold = (lastEmittedPtsSec === 0 || forwardSec < 4) ? 8 : 24;

  const shouldEmit =
    videoBlocks.length >= minBlocksThreshold ||
    (!inCluster && videoBlocks.length > 0) ||
    (isEof && videoBlocks.length > 0);

  if (shouldEmit) {
    const result = transmuxer.transmuxBlocks(blocks);

    if (result?.initSegment) {
      postWorkerMessage(
        {
          type: 'INIT_SEGMENT',
          buffer: result.initSegment.buffer,
        },
        [result.initSegment.buffer]
      );
    }

    if (result?.audioInitSegment) {
      postWorkerMessage(
        {
          type: 'AUDIO_INIT_SEGMENT',
          buffer: result.audioInitSegment.buffer,
        },
        [result.audioInitSegment.buffer]
      );
    }

    if (result?.mediaSegment) {
      lastEmittedPtsSec = result.endPtsMs / 1000;
      postWorkerMessage(
        {
          type: 'MEDIA_SEGMENT',
          buffer: result.mediaSegment.buffer,
          startPtsSec: result.startPtsMs / 1000,
          endPtsSec: result.endPtsMs / 1000,
          samplesCount: result.samplesCount,
        },
        [result.mediaSegment.buffer]
      );
    }

    if (result?.audioMediaSegment) {
      postWorkerMessage(
        {
          type: 'AUDIO_MEDIA_SEGMENT',
          buffer: result.audioMediaSegment.buffer,
        },
        [result.audioMediaSegment.buffer]
      );
    }

    clusterAccumulator = clusterAccumulator.slice(bytesConsumed);
    return true;
  }

  // If header or timestamp was parsed with no blocks, consume those bytes
  if (bytesConsumed > 0 && blocks.length === 0) {
    clusterAccumulator = clusterAccumulator.slice(bytesConsumed);
    return true;
  }

  return false;
}

/**
 * Handles fast byte-range seeking to target timestamp
 */
async function seekTo(targetTimeSec: number) {
  if (!metadata || !downloadWindow) return;

  activeLoopId++;
  const thisLoopId = activeLoopId;
  fetcher.abortAll();
  isBufferFull = false;
  clusterAccumulator = new Uint8Array(0);
  inCluster = false;
  currentClusterTimeMs = 0;
  clusterPayloadRemaining = -1;

  currentPlayheadSec = targetTimeSec;
  lastEmittedPtsSec = targetTimeSec;

  postWorkerMessage({ type: 'STATUS', status: `Seeking to ${Math.round(targetTimeSec)}s...` });

  let targetByteOffset = metadata.segmentDataOffset;
  let targetTimeMs = targetTimeSec * 1000;

  // 1. Check Cues index
  if (metadata.cues.length > 0) {
    let bestCue: CueEntry | null = null;
    for (const cue of metadata.cues) {
      if (cue.timeMs <= targetTimeMs) {
        if (!bestCue || cue.timeMs > bestCue.timeMs) {
          bestCue = cue;
        }
      }
    }
    if (bestCue) {
      targetByteOffset = metadata.segmentDataOffset + bestCue.clusterOffset;
      targetTimeSec = bestCue.timeMs / 1000;
    }
  } else if (metadata.durationSec > 0 && totalFileSize > 0) {
    // Fallback: estimate from average bitrate
    const ratio = Math.max(0, Math.min(1, targetTimeSec / metadata.durationSec));
    const estimated = metadata.segmentDataOffset + Math.floor(ratio * (totalFileSize - metadata.segmentDataOffset));
    // Step back 1MB to ensure we don't start past the keyframe cluster preceding the target
    const steppedBack = Math.max(metadata.segmentDataOffset, estimated - 1024 * 1024);
    targetByteOffset = DownloadWindow.alignOffset(steppedBack);
  }

  // Align to 4096 bytes
  targetByteOffset = DownloadWindow.alignOffset(targetByteOffset);
  currentReadOffset = targetByteOffset;

  transmuxer?.resetSequence(targetTimeMs);

  postWorkerMessage({
    type: 'SEEK_READY',
    actualTimeSec: targetTimeSec,
    targetByteOffset,
  });

  // Resume streaming loop from new offset
  runStreamLoop(thisLoopId);
}

// Worker message listener
self.onmessage = (event) => {
  const { type } = event.data || {};

  switch (type) {
    case 'START':
      startStream(
        event.data.channelId,
        event.data.messageId,
        event.data.fileSize,
        event.data.mimeType
      );
      break;

    case 'SEEK':
      seekTo(event.data.targetTimeSec);
      break;

    case 'PLAYHEAD_UPDATE':
      currentPlayheadSec = event.data.currentTimeSec || 0;
      isVideoPaused = Boolean(event.data.isPaused);
      break;

    case 'PAUSE':
      isPaused = true;
      break;

    case 'RESUME':
      isPaused = false;
      break;

    case 'STOP':
      isRunning = false;
      activeLoopId++;
      fetcher.abortAll();
      clusterAccumulator = new Uint8Array(0);
      break;

    case 'FETCH_CHUNK_RESPONSE':
      fetcher.handleMessage(event.data);
      break;
  }
};
