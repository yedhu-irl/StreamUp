import assert from 'node:assert';
import { DownloadWindow } from '../src/services/downloadWindow.ts';
import {
  parseMatroskaHeader,
  parseClusterPayload,
  annexBToAvcc,
  EBML_ID,
} from '../src/services/remuxer/ebml.ts';
import { MatroskaTransmuxer } from '../src/services/remuxer/transmuxer.ts';

console.log('Running End-to-End Demux/Remux Pipeline Test...');

// 1. Synthesize a valid minimal Matroska file buffer
// EBML Header
const ebmlHeader = [
  0x1a, 0x45, 0xdf, 0xa3, // EBML
  0x85,                   // Size 5
  0x42, 0x82, 0x83, 0x6d, 0x6b, 0x76, // DocType: 'mkv'
];

// Segment Header: Size 0x01, 0xff... (indefinite size)
const segmentHeader = [
  0x18, 0x53, 0x80, 0x67, // Segment
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

// Info Element: TimecodeScale 1,000,000, Duration 60.0
const infoElem = [
  0x15, 0x49, 0xa9, 0x66, // Info
  0x87,                   // Size 7
  0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, // TimecodeScale = 1,000,000
];

// CodecPrivate: AVCDecoderConfigurationRecord with SPS and PPS
const avcC = [
  0x01, 0x64, 0x00, 0x1f, 0xff,
  0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, // 1 SPS
  0x01, 0x00, 0x03, 0x68, 0xeb, 0xe3,       // 1 PPS
];

// Tracks Element with 1 Video Track
const videoSettings = [
  0xb0, 0x82, 0x07, 0x80, // PixelWidth = 1920 (0x0780)
  0xba, 0x82, 0x04, 0x38, // PixelHeight = 1080 (0x0438)
];

const videoElem = [
  0xe0, 0x80 + videoSettings.length,
  ...videoSettings,
];

const codecIdBytes = Buffer.from('V_MPEG4/ISO/AVC');
const trackChildren = [
  0xd7, 0x81, 0x01, // TrackNumber = 1
  0x83, 0x81, 0x01, // TrackType = 1 (Video)
  0x86, 0x80 + codecIdBytes.length, ...codecIdBytes, // CodecID
  0x63, 0xa2, 0x80 + avcC.length, ...avcC,          // CodecPrivate
  ...videoElem,
];

const trackEntry = [
  0xae, // TrackEntry
  0x80 + trackChildren.length,
  ...trackChildren,
];

const tracksElem = [
  0x16, 0x54, 0xae, 0x6b, // Tracks
  0x80 + trackEntry.length,
  ...trackEntry,
];

// Cluster 1: Timecode 0, 1 Keyframe SimpleBlock
const frame1 = [0x00, 0x00, 0x00, 0x02, 0x65, 0x88]; // IDR frame
const simpleBlock1 = [
  0xa3, 0x80 + 4 + frame1.length,
  0x81, 0x00, 0x00, 0x80, // Track 1, relTime 0, keyframe
  ...frame1,
];

const cluster1 = [
  0x1f, 0x43, 0xb6, 0x75, // Cluster
  0x80 + 4 + simpleBlock1.length,
  0xe7, 0x81, 0x00,       // Timecode = 0
  ...simpleBlock1,
];

const fullBuffer = new Uint8Array([
  ...ebmlHeader,
  ...segmentHeader,
  ...infoElem,
  ...tracksElem,
  ...cluster1,
]);

console.log(`Synthesized MKV test file: ${fullBuffer.length} bytes`);

// 2. Parse Header
const meta = parseMatroskaHeader(fullBuffer);
console.log('Parsed videoTrack:', meta?.videoTracks[0]);
assert.ok(meta, 'Header parsing failed');
assert.strictEqual(meta.videoTracks.length, 1);
assert.strictEqual(meta.videoTracks[0].width, 1920);
assert.strictEqual(meta.videoTracks[0].height, 1080);
assert.strictEqual(meta.videoTracks[0].sps.length, 4);
assert.strictEqual(meta.videoTracks[0].pps.length, 3);

// 3. Transmuxer
const transmuxer = new MatroskaTransmuxer(meta);
const initSegment = transmuxer.generateInitSegment();
assert.ok(initSegment);
assert.ok(initSegment.length > 0);

// Verify ftyp and moov
const ftypTag = String.fromCharCode(...initSegment.subarray(4, 8));
assert.strictEqual(ftypTag, 'ftyp');

// 4. Cluster Transmuxing
const clusterPayload = new Uint8Array(cluster1.slice(4 + 1)); // strip cluster ID and size
const result = transmuxer.transmuxCluster(clusterPayload);
assert.ok(result);
assert.strictEqual(result.samplesCount, 1);
assert.ok(result.mediaSegment);

// Verify moof and mdat
const moofTag = String.fromCharCode(...result.mediaSegment.subarray(4, 8));
assert.strictEqual(moofTag, 'moof');

// Verify trun sample_count and data_offset
const seg = result.mediaSegment;
let trunIdx = -1;
for (let i = 0; i < seg.length - 16; i++) {
  if (seg[i] === 0x74 && seg[i+1] === 0x72 && seg[i+2] === 0x75 && seg[i+3] === 0x6e) {
    trunIdx = i;
    break;
  }
}
assert.ok(trunIdx !== -1, 'trun box must exist in moof');
const parsedSampleCount = (seg[trunIdx + 8] << 24) | (seg[trunIdx + 9] << 16) | (seg[trunIdx + 10] << 8) | seg[trunIdx + 11];
const parsedDataOffset = (seg[trunIdx + 12] << 24) | (seg[trunIdx + 13] << 16) | (seg[trunIdx + 14] << 8) | seg[trunIdx + 15];
assert.strictEqual(parsedSampleCount, 1, `trun sample_count must be 1, got ${parsedSampleCount}`);
assert.ok(parsedDataOffset > 50, `trun data_offset must point past moof, got ${parsedDataOffset}`);

console.log(`Verified trun box: sample_count=${parsedSampleCount}, data_offset=${parsedDataOffset}`);

console.log('Pipeline test passed! Generated valid fMP4 initialization and media segments.');

// 5. Test HEVC Track Remuxing
console.log('Running HEVC Demux/Remux Pipeline Test...');
const hevcCodecIdBytes = Buffer.from('V_MPEGH/ISO/HEVC');
const hevcConfig = new Uint8Array([
  0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d,
  0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0x00, 0x00, 0x0f, 0x00,
]);

const hevcMeta = {
  docType: 'matroska',
  timecodeScale: 1000000,
  durationSec: 120,
  segmentDataOffset: 100,
  videoTracks: [
    {
      trackNumber: 1,
      trackType: 1,
      codecId: 'V_MPEGH/ISO/HEVC',
      width: 1920,
      height: 1080,
      codecPrivate: hevcConfig,
      defaultDuration: 40000000,
    },
  ],
  audioTracks: [],
  cues: [],
};

const hevcTransmuxer = new MatroskaTransmuxer(hevcMeta);
const hevcCodecString = hevcTransmuxer.getVideoCodecString();
console.log('HEVC Codec String:', hevcCodecString);
assert.ok(hevcCodecString.includes('hvc1'), 'Must produce hvc1 codec string');

const hevcInitSegment = hevcTransmuxer.generateInitSegment();
assert.ok(hevcInitSegment, 'HEVC init segment should be generated');
assert.ok(hevcInitSegment.length > 0);
const hevcFtypTag = String.fromCharCode(...hevcInitSegment.subarray(4, 8));
assert.strictEqual(hevcFtypTag, 'ftyp');

console.log('HEVC pipeline test passed cleanly!');

// 6. Test Audio Init and Media Segment Generation
console.log('Running Audio Remux Pipeline Test...');
import {
  generateAudioInitSegment,
  generateAudioMediaSegment,
} from '../src/services/remuxer/mp4Generator.ts';

const audioConfig = {
  trackId: 2,
  timescale: 1000,
  channelCount: 2,
  sampleRate: 48000,
  audioSpecificConfig: new Uint8Array([0x11, 0x90]), // AAC-LC 48kHz stereo
};

const audioInit = generateAudioInitSegment(audioConfig);
assert.ok(audioInit, 'Audio init segment must be generated');
assert.ok(audioInit.length > 50, 'Audio init segment must have valid size');
const aInitFtyp = String.fromCharCode(...audioInit.subarray(4, 8));
assert.strictEqual(aInitFtyp, 'ftyp');

// Verify soun and smhd in audio init
let hasSoun = false;
let hasSmhd = false;
let hasMp4a = false;
for (let i = 0; i < audioInit.length - 4; i++) {
  const tag = String.fromCharCode(...audioInit.subarray(i, i + 4));
  if (tag === 'soun') hasSoun = true;
  if (tag === 'smhd') hasSmhd = true;
  if (tag === 'mp4a') hasMp4a = true;
}
assert.ok(hasSoun, 'Audio init must contain soun handler');
assert.ok(hasSmhd, 'Audio init must contain smhd box');
assert.ok(hasMp4a, 'Audio init must contain mp4a sample entry');

// Test Audio Media Segment
const aSample = {
  data: new Uint8Array([0x21, 0x10, 0x05, 0x00]), // mock AAC access unit
  duration: 21, // ~21ms
  pts: 0,
};
const audioMedia = generateAudioMediaSegment(1, 0, 2, [aSample]);
assert.ok(audioMedia, 'Audio media segment must be generated');
const aMoofTag = String.fromCharCode(...audioMedia.subarray(4, 8));
assert.strictEqual(aMoofTag, 'moof');

let aTrunIdx = -1;
for (let i = 0; i < audioMedia.length - 16; i++) {
  if (
    audioMedia[i] === 0x74 &&
    audioMedia[i + 1] === 0x72 &&
    audioMedia[i + 2] === 0x75 &&
    audioMedia[i + 3] === 0x6e
  ) {
    aTrunIdx = i;
    break;
  }
}
assert.ok(aTrunIdx !== -1, 'trun must exist in audio moof');
const aSampleCount =
  (audioMedia[aTrunIdx + 8] << 24) |
  (audioMedia[aTrunIdx + 9] << 16) |
  (audioMedia[aTrunIdx + 10] << 8) |
  audioMedia[aTrunIdx + 11];
const aDataOffset =
  (audioMedia[aTrunIdx + 12] << 24) |
  (audioMedia[aTrunIdx + 13] << 16) |
  (audioMedia[aTrunIdx + 14] << 8) |
  audioMedia[aTrunIdx + 15];

assert.strictEqual(aSampleCount, 1, 'Audio sample_count must be 1');
assert.ok(aDataOffset > 40, `Audio data_offset must point to mdat, got ${aDataOffset}`);
console.log(`Verified Audio trun: sample_count=${aSampleCount}, data_offset=${aDataOffset}`);
console.log('Audio remux pipeline test passed cleanly!');
