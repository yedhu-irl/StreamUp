import assert from 'node:assert';
import {
  EBML_ID,
  readElementId,
  readDataSize,
  annexBToAvcc,
  splitAnnexBNals,
  extractAvcParameters,
  parseSimpleBlock,
  parseClusterPayload,
  findNextCluster,
} from '../src/services/remuxer/ebml.ts';

console.log('Running EBML Parser Tests...');

// 1. EBML Element ID tests (leading bits preserved)
const segIdBuf = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
const parsedId = readElementId(segIdBuf, 0);
assert.strictEqual(parsedId.value, EBML_ID.SEGMENT);
assert.strictEqual(parsedId.length, 4);

const trackEntryBuf = new Uint8Array([0xae]);
const parsedTe = readElementId(trackEntryBuf, 0);
assert.strictEqual(parsedTe.value, EBML_ID.TRACK_ENTRY);
assert.strictEqual(parsedTe.length, 1);

// 2. EBML Data Size tests (leading bits masked off)
// Length 1: 0x85 -> size 5
const size1Buf = new Uint8Array([0x85]);
const s1 = readDataSize(size1Buf, 0);
assert.strictEqual(s1.value, 5);
assert.strictEqual(s1.length, 1);

// Length 2: 0x40 0x10 -> size 16
const size2Buf = new Uint8Array([0x40, 0x10]);
const s2 = readDataSize(size2Buf, 0);
assert.strictEqual(s2.value, 16);
assert.strictEqual(s2.length, 2);

// Indefinite size: 0x01 0xff 0xff 0xff 0xff 0xff 0xff 0xff
const indefBuf = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const sIndef = readDataSize(indefBuf, 0);
assert.strictEqual(sIndef.value, -1);

// 3. Annex B to AVCC conversion
const annexBFrame = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, // SPS
  0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,       // PPS (3-byte start code)
  0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00  // IDR Slice
]);

const avcc = annexBToAvcc(annexBFrame);
// First NAL should be 4 bytes size followed by SPS (4 bytes data)
assert.strictEqual(avcc[0], 0);
assert.strictEqual(avcc[1], 0);
assert.strictEqual(avcc[2], 0);
assert.strictEqual(avcc[3], 4);
assert.strictEqual(avcc[4], 0x67);

// 4. Extract SPS/PPS from AVCDecoderConfigurationRecord
const avcCRecord = new Uint8Array([
  0x01, // version 1
  0x64, // profile High
  0x00, // profile compat
  0x1f, // level 3.1
  0xff, // 4-byte NAL length
  0xe1, // 1 SPS
  0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, // SPS (4 bytes)
  0x01, // 1 PPS
  0x00, 0x03, 0x68, 0xeb, 0xe3        // PPS (3 bytes)
]);
const params = extractAvcParameters(avcCRecord);
assert.strictEqual(params.sps.length, 4);
assert.strictEqual(params.sps[0], 0x67);
assert.strictEqual(params.pps.length, 3);
assert.strictEqual(params.pps[0], 0x68);

// 5. Parse SimpleBlock
const simpleBlockBuf = new Uint8Array([
  0x81,                   // Track 1 (VINT 0x81 -> 1)
  0x00, 0x28,             // Relative time +40ms
  0x80,                   // Keyframe flag = 0x80 (no lacing)
  0x11, 0x22, 0x33, 0x44  // Payload
]);
const block = parseSimpleBlock(simpleBlockBuf);
assert.strictEqual(block.trackNumber, 1);
assert.strictEqual(block.relativeTime, 40);
assert.strictEqual(block.isKeyframe, true);
assert.strictEqual(block.data.length, 4);
assert.strictEqual(block.data[0], 0x11);

// 6. Cluster scanner & Cluster payload parsing
// Build mock cluster payload: [TimeCode (0xe7) sz 2 -> 5000ms] [SimpleBlock (0xa3) sz 4 -> relativeTime 40ms]
const mockCluster = new Uint8Array([
  0xe7, 0x82, 0x13, 0x88, // TimeCode = 5000 (0x1388)
  0xa3, 0x84, 0x81, 0x00, 0x28, 0x80 // SimpleBlock: track 1, relTime 40, keyframe
]);
const parsedCluster = parseClusterPayload(mockCluster);
assert.strictEqual(parsedCluster.clusterTimeMs, 5000);
assert.strictEqual(parsedCluster.blocks.length, 1);
assert.strictEqual(parsedCluster.blocks[0].ptsMs, 5040);
assert.strictEqual(parsedCluster.blocks[0].isKeyframe, true);

// 7. Cluster scanner
const streamWithCluster = new Uint8Array([0x00, 0x12, 0x34, 0x1f, 0x43, 0xb6, 0x75, 0x01, 0x02]);
const clusterIdx = findNextCluster(streamWithCluster);
assert.strictEqual(clusterIdx, 3);

// 8. Multi-NAL AVCC frame preservation (prevents prepending duplicate outer length)
const multiNalAvcc = new Uint8Array([
  0x00, 0x00, 0x00, 0x02, 0x09, 0xf0, // AUD NAL (2 bytes)
  0x00, 0x00, 0x00, 0x04, 0x65, 0x88, 0x80, 0x10 // IDR Slice NAL (4 bytes)
]);
const preservedAvcc = annexBToAvcc(multiNalAvcc);
assert.strictEqual(preservedAvcc.length, 14, `Preserved AVCC length must be 14, got ${preservedAvcc.length}`);
assert.deepStrictEqual(Array.from(preservedAvcc), Array.from(multiNalAvcc));

console.log('All EBML tests passed!');
