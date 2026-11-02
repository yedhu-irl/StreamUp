import assert from 'node:assert';
import { MatroskaTransmuxer } from '../src/services/remuxer/transmuxer.ts';

console.log('Running Transmuxer Tests...');

const sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xba, 0x10]);
const pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);

const mockMetadata = {
  docType: 'matroska',
  timecodeScale: 1_000_000,
  durationSec: 120,
  segmentDataOffset: 100,
  videoTracks: [
    {
      trackNumber: 1,
      trackType: 1,
      codecId: 'V_MPEG4/ISO/AVC',
      width: 1920,
      height: 1080,
      sps,
      pps,
      defaultDuration: 40_000_000, // 40ms = 25fps
    },
  ],
  audioTracks: [
    {
      trackNumber: 2,
      trackType: 2,
      codecId: 'A_AAC',
      channels: 2,
      samplingFrequency: 48000,
    },
  ],
  cues: [],
};

const transmuxer = new MatroskaTransmuxer(mockMetadata);

// 1. Initial State
assert.strictEqual(transmuxer.hasInitSegment(), false);
assert.strictEqual(transmuxer.getVideoCodecString().startsWith('video/mp4; codecs="avc1.'), true);
assert.strictEqual(transmuxer.isAudioSupported(), true);

// 2. Generate Init Segment
const initSegment = transmuxer.generateInitSegment();
assert.ok(initSegment);
assert.ok(initSegment.length > 0);
assert.strictEqual(transmuxer.hasInitSegment(), true);

// Verify ftyp and moov in initSegment
// First 4 bytes size, next 4 bytes 'ftyp'
const ftypStr = String.fromCharCode(...initSegment.subarray(4, 8));
assert.strictEqual(ftypStr, 'ftyp');

// 3. Transmux a Cluster
// Cluster payload with TimeCode 2000ms, and 2 SimpleBlocks at 0ms and 40ms
const frame1 = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]); // 2-byte AVCC slice
const frame2 = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0x99]); // non-key slice

const clusterPayload = new Uint8Array([
  0xe7, 0x82, 0x07, 0xd0, // Timecode = 2000ms
  // SimpleBlock 1: track 1, relTime 0, keyframe 0x80, frame1
  0xa3, 0x80 + 4 + frame1.length, 0x81, 0x00, 0x00, 0x80, ...frame1,
  // SimpleBlock 2: track 1, relTime 40, non-key 0x00, frame2
  0xa3, 0x80 + 4 + frame2.length, 0x81, 0x00, 0x28, 0x00, ...frame2,
]);

const res = transmuxer.transmuxCluster(clusterPayload);
assert.ok(res);
assert.strictEqual(res.samplesCount, 2);
assert.strictEqual(res.startPtsMs, 2000);
assert.strictEqual(res.endPtsMs, 2080);
assert.ok(res.mediaSegment);

// Verify 'moof' box in mediaSegment
const moofStr = String.fromCharCode(...res.mediaSegment.subarray(4, 8));
assert.strictEqual(moofStr, 'moof');

console.log('All Transmuxer tests passed!');

