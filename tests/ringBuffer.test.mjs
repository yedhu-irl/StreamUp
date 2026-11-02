import assert from 'node:assert';
import { planSymmetricRingBuffer, isChunkInActiveWindow } from '../src/services/windowPlanner.ts';

console.log('Running Symmetric Dual-Direction Ring Buffer Tests (30s Back / 30s Forward)...');

// Case 1: Beginning of movie (currentTime = 0, duration = 7200s, size = 2GB)
const planStart = planSymmetricRingBuffer(0, 7200, 2 * 1024 * 1024 * 1024);
assert.strictEqual(planStart.currentChunk, 0);
assert.strictEqual(planStart.startChunk, 0);
assert(planStart.endChunk >= 10, 'Should buffer at least 10 chunks forward (5+ MB)');
assert(planStart.pinnedChunks.includes(0), 'Chunk 0 header must be pinned');
assert(planStart.pinnedChunks.includes(1), 'Chunk 1 header must be pinned');
assert(planStart.chunksToPreload.length > 0, 'Must have preload chunks');

// Case 2: Middle of movie (currentTime = 3600s, duration = 7200s, size = 2GB)
const planMid = planSymmetricRingBuffer(3600, 7200, 2 * 1024 * 1024 * 1024);
assert(planMid.currentChunk > 1000, 'Current chunk in middle of 2GB file');
assert(planMid.startChunk < planMid.currentChunk, 'startChunk must be behind currentChunk (-30s)');
assert(planMid.endChunk > planMid.currentChunk, 'endChunk must be ahead of currentChunk (+30s)');
assert.strictEqual(planMid.endChunk - planMid.currentChunk, planMid.currentChunk - planMid.startChunk, 'Ring buffer should be symmetric around current chunk');

// Case 3: Skip ±10s test within ±30s window
// When user is at 3600s, a skip to 3610s or 3590s remains within [startChunk, endChunk]
const chunkAt3610 = Math.floor(((3610 / 7200) * 2 * 1024 * 1024 * 1024) / (512 * 1024));
assert(chunkAt3610 >= planMid.startChunk && chunkAt3610 <= planMid.endChunk, '+10s skip must reside inside the 30s ring buffer');

// Case 4: Active window check
assert(isChunkInActiveWindow(planMid.currentChunk, planMid.startChunk, planMid.endChunk, planMid.pinnedChunks));
assert(isChunkInActiveWindow(0, planMid.startChunk, planMid.endChunk, planMid.pinnedChunks), 'Chunk 0 must always be active via pin');
assert(!isChunkInActiveWindow(100, planMid.startChunk, planMid.endChunk, planMid.pinnedChunks), 'Unpinned chunk outside window must be inactive for eviction');

console.log('Symmetric Ring Buffer Tests Passed Cleanly!');

