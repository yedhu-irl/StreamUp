export interface ByteRange {
  start: number;
  end: number; // exclusive
}

export interface WindowPlanRequest {
  offset: number;
  limit: number;
  deleteFirst: boolean;
  ranges: ByteRange[];
}

export const DEFAULT_WINDOW_BYTES = 200 * 1024 * 1024; // 200 MB rolling window
export const ROLL_MARGIN_BYTES = 4 * 1024 * 1024;      // Roll when playhead is within 4 MB of window end
export const ROLL_BACKOFF_BYTES = 2 * 1024 * 1024;     // Keep 2 MB behind playhead on roll
export const SLACK_BYTES = 16 * 1024 * 1024;           // 16 MB slack for MP4 moov / MKV Cues end-of-file jumps
export const METERED_WINDOW_BYTES = 100 * 1024 * 1024; // 100 MB window on metered connections
export const EXTEND_MARGIN_BYTES = 16 * 1024 * 1024;

export function mergeRanges(ranges: ByteRange[]): ByteRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ByteRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

export function totalRangeBytes(ranges: ByteRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
}

/**
 * Checks if a chunk is pinned (first 2 chunks or last 2 chunks of a container)
 */
export function isPinnedChunk(chunkIndex: number, totalChunks: number): boolean {
  if (chunkIndex <= 1) return true;
  if (totalChunks > 2 && chunkIndex >= totalChunks - 2) return true;
  return false;
}

export function planWindow(
  ranges: ByteRange[],
  offset: number,
  size: number,
  windowBytes: number = DEFAULT_WINDOW_BYTES,
  roll: boolean = false
): WindowPlanRequest {
  const end = size > 0 ? Math.min(size, offset + windowBytes) : offset + windowBytes;
  // CRITICAL: limit must ALWAYS be >= 1 (0 in Telegram/TDLib means "no limit / download whole file")
  const limit = Math.max(1, end - offset);
  const wanted: ByteRange = { start: offset, end };
  const kept = mergeRanges([...ranges, wanted]);
  const budget = windowBytes + SLACK_BYTES;

  if (roll) {
    return { offset, limit, deleteFirst: true, ranges: [wanted] };
  }
  if (totalRangeBytes(kept) <= budget) {
    return { offset, limit, deleteFirst: false, ranges: kept };
  }
  return { offset, limit, deleteFirst: true, ranges: [wanted] };
}

export interface SymmetricRingBufferPlan {
  currentChunk: number;
  startChunk: number; // 60s backward bound
  endChunk: number;   // 60s forward bound
  pinnedChunks: number[];
  chunksToPreload: number[];
}

const CHUNK_SIZE = 512 * 1024;

/**
 * Calculates a symmetric dual-direction ring buffer (30s forward, 30s backward - total 1 min)
 * around the current playback timestamp.
 */
export function planSymmetricRingBuffer(
  currentTimeSec: number,
  durationSec: number,
  totalFileSize: number
): SymmetricRingBufferPlan {
  const totalChunks = Math.max(1, Math.ceil(totalFileSize / CHUNK_SIZE));

  let currentByte = 0;
  let bytesPerSec = (2.5 * 1024 * 1024) / 8; // fallback ~320 KB/s

  if (durationSec > 0 && totalFileSize > 0) {
    bytesPerSec = Math.max(150 * 1024, totalFileSize / durationSec);
    const ratio = Math.max(0, Math.min(1, currentTimeSec / durationSec));
    currentByte = Math.floor(ratio * totalFileSize);
  }

  const currentChunk = Math.floor(currentByte / CHUNK_SIZE);
  // 30s window calculation (total 1 minute)
  const ringBytes = Math.max(6 * 1024 * 1024, Math.min(25 * 1024 * 1024, Math.ceil(30 * bytesPerSec)));
  const ringChunks = Math.max(3, Math.ceil(ringBytes / CHUNK_SIZE));

  const startChunk = Math.max(0, currentChunk - ringChunks);
  const endChunk = Math.min(totalChunks - 1, currentChunk + ringChunks);

  // Pinned chunks: first 2 chunks (container header) and last 2 chunks (moov/Cues)
  const pinnedChunks: number[] = [0];
  if (totalChunks > 1) pinnedChunks.push(1);
  if (totalChunks > 2) pinnedChunks.push(totalChunks - 1);
  if (totalChunks > 3) pinnedChunks.push(totalChunks - 2);

  // Chunks to preload prioritizes current -> forward 30s -> backward 30s
  const chunksToPreload: number[] = [];
  for (let c = currentChunk; c <= endChunk; c++) {
    chunksToPreload.push(c);
  }
  for (let c = currentChunk - 1; c >= startChunk; c--) {
    chunksToPreload.push(c);
  }

  return {
    currentChunk,
    startChunk,
    endChunk,
    pinnedChunks,
    chunksToPreload,
  };
}

export function isChunkInActiveWindow(
  chunkIndex: number,
  startChunk: number,
  endChunk: number,
  pinnedChunks: number[]
): boolean {
  if (pinnedChunks.includes(chunkIndex)) return true;
  return chunkIndex >= startChunk && chunkIndex <= endChunk;
}

