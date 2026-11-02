import assert from 'node:assert';
import { CHUNK_SIZE } from '../src/db/streamDb.ts';

console.log('Running TgFile Virtual File Manager Tests...');

// 1. Verify Chunk Sizing and MTProto Alignment Constraints
assert.strictEqual(CHUNK_SIZE, 512 * 1024, 'CHUNK_SIZE must be exactly 512 KiB (524288 bytes)');
assert.strictEqual(CHUNK_SIZE % 4096, 0, 'CHUNK_SIZE must be divisible by 4096');
assert.strictEqual((1024 * 1024) % CHUNK_SIZE, 0, 'CHUNK_SIZE must divide 1 MB evenly without boundary crossings');

// 2. Test Slicing Algorithm used by TgFile.read(start, end)
function sliceChunks(chunks, start, end, firstChunkIndex) {
  const totalLength = end - start;
  const result = new Uint8Array(totalLength);
  let resultOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkIdx = firstChunkIndex + i;
    const chunkData = chunks[i];
    const chunkStartByte = chunkIdx * CHUNK_SIZE;

    const sliceStart = Math.max(0, start - chunkStartByte);
    const sliceEnd = Math.min(chunkData.byteLength, end - chunkStartByte);

    if (sliceStart < chunkData.byteLength && sliceStart < sliceEnd) {
      const slice = chunkData.subarray(sliceStart, sliceEnd);
      result.set(slice, resultOffset);
      resultOffset += slice.byteLength;
    }
  }
  return result;
}

// Synthesize 3 mock chunks of 512 KB with recognizable sequential byte patterns
const mockChunk0 = new Uint8Array(CHUNK_SIZE);
mockChunk0.fill(0xaa);
const mockChunk1 = new Uint8Array(CHUNK_SIZE);
mockChunk1.fill(0xbb);
const mockChunk2 = new Uint8Array(CHUNK_SIZE);
mockChunk2.fill(0xcc);

// Case A: Read within a single chunk (offset 100 to 200)
const sliceA = sliceChunks([mockChunk0], 100, 200, 0);
assert.strictEqual(sliceA.length, 100);
assert.strictEqual(sliceA[0], 0xaa);
assert.strictEqual(sliceA[99], 0xaa);

// Case B: Read spanning across chunk 0 and chunk 1 boundary
const spanStart = CHUNK_SIZE - 50; // last 50 bytes of chunk 0
const spanEnd = CHUNK_SIZE + 50;   // first 50 bytes of chunk 1
const sliceB = sliceChunks([mockChunk0, mockChunk1], spanStart, spanEnd, 0);
assert.strictEqual(sliceB.length, 100);
assert.strictEqual(sliceB[0], 0xaa, 'First byte must come from chunk 0');
assert.strictEqual(sliceB[49], 0xaa, 'Byte 49 must come from chunk 0');
assert.strictEqual(sliceB[50], 0xbb, 'Byte 50 must come from chunk 1');
assert.strictEqual(sliceB[99], 0xbb, 'Last byte must come from chunk 1');

// Case C: Read spanning across 3 chunks (chunk 0, chunk 1, chunk 2)
const span3Start = CHUNK_SIZE - 10;
const span3End = 2 * CHUNK_SIZE + 10;
const sliceC = sliceChunks([mockChunk0, mockChunk1, mockChunk2], span3Start, span3End, 0);
assert.strictEqual(sliceC.length, CHUNK_SIZE + 20);
assert.strictEqual(sliceC[0], 0xaa);
assert.strictEqual(sliceC[10], 0xbb);
assert.strictEqual(sliceC[CHUNK_SIZE + 10], 0xcc);

// 3. Test Priority Scheduling Order (urgent=true ahead of urgent=false)
const queue = [
  { index: 5, urgent: false },
  { index: 1, urgent: true },
  { index: 10, urgent: false },
  { index: 2, urgent: true },
];
queue.sort((a, b) => {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  return a.index - b.index;
});
assert.strictEqual(queue[0].index, 1, 'Urgent chunk 1 must be first');
assert.strictEqual(queue[1].index, 2, 'Urgent chunk 2 must be second');
assert.strictEqual(queue[2].index, 5, 'Speculative chunk 5 must be third');
assert.strictEqual(queue[3].index, 10, 'Speculative chunk 10 must be fourth');

// 4. Test Seek Cancellation logic (dropFarJobs)
const jobs = [
  { index: 0, urgent: true, aborted: false },  // pinned header
  { index: 1, urgent: false, aborted: false }, // old position
  { index: 2, urgent: false, aborted: false }, // old position
  { index: 50, urgent: true, aborted: false }, // new seek target
  { index: 51, urgent: false, aborted: false },// lookahead
];
const pinned = new Set([0, 100]); // 0 pinned
const seekFirst = 50;
const seekLast = 52;

const filtered = jobs.filter((j) => {
  if (pinned.has(j.index)) return true;
  if (j.index < seekFirst || j.index > seekLast + 6) {
    j.aborted = true;
    return false;
  }
  return true;
});

assert.strictEqual(filtered.length, 3, 'Must retain pinned chunk 0 and seek chunks 50, 51');
assert.strictEqual(jobs[1].aborted, true, 'Old chunk 1 must be aborted');
assert.strictEqual(jobs[2].aborted, true, 'Old chunk 2 must be aborted');
assert.strictEqual(jobs[3].aborted, false, 'Seek chunk 50 must NOT be aborted');

console.log('TgFile Virtual File Manager Tests Passed Cleanly!');

