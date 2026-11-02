import assert from 'node:assert';
import { MatroskaTransmuxer } from '../../src/services/remuxer/transmuxer.ts';
import { parseSimpleBlock } from '../../src/services/remuxer/ebml.ts';
import { MSEController } from '../../src/services/mseController.ts';

console.log('Running Milestone M1 Verification Tests...');

// 1. Verify AC-3 audio reporting (prevents audio SourceBuffer deadlock)
const ac3Meta = {
  docType: 'matroska',
  timecodeScale: 1000000,
  durationSec: 100,
  segmentDataOffset: 100,
  videoTracks: [{ trackNumber: 1, trackType: 1, codecId: 'V_MPEG4/ISO/AVC' }],
  audioTracks: [{ trackNumber: 2, trackType: 2, codecId: 'A_AC3' }],
  cues: []
};
const ac3Trans = new MatroskaTransmuxer(ac3Meta);
assert.strictEqual(ac3Trans.isAudioSupported(), false, 'AC-3 must not be reported as supported');
assert.strictEqual(ac3Trans.getAudioCodecString(), null, 'AC-3 codec string must be null');
assert.strictEqual(ac3Trans.getAudioCodecName(), 'AC3');
console.log('PASS: AC-3 capability check passed');

// 2. Verify Multi-track preference (AC-3 track 2 + AAC track 3)
const multiMeta = {
  ...ac3Meta,
  audioTracks: [
    { trackNumber: 2, trackType: 2, codecId: 'A_AC3' },
    { trackNumber: 3, trackType: 2, codecId: 'A_AAC' }
  ]
};
const multiTrans = new MatroskaTransmuxer(multiMeta);
assert.strictEqual(multiTrans.isAudioSupported(), true, 'Multi-track with AAC must be supported');
assert.strictEqual(multiTrans.getAudioTrackNumber(), 3, 'Must prefer AAC track 3');
assert.strictEqual(multiTrans.getAudioCodecString(), 'audio/mp4; codecs="mp4a.40.2"');
console.log('PASS: Multi-track preference check passed');

// 3. Verify Xiph Lacing in parseSimpleBlock
// Header: track 2 (0x82), relTime 0 (0x00, 0x00), flags (0x80 | (1 << 1) = 0x82)
// Xiph lacing: 2 frames (numFrames - 1 = 1) -> byte 0x01
// Frame 1 size: 4 bytes (0x04)
// Frame 1: [1, 2, 3, 4]
// Frame 2 (remainder): [5, 6, 7]
const xiphBlock = new Uint8Array([
  0x82, 0x00, 0x00, 0x82,
  0x01, 0x04,
  1, 2, 3, 4,
  5, 6, 7
]);
const parsedXiph = parseSimpleBlock(xiphBlock);
assert.ok(parsedXiph);
assert.strictEqual(parsedXiph.trackNumber, 2);
assert.strictEqual(parsedXiph.frames.length, 2);
assert.deepStrictEqual(Array.from(parsedXiph.frames[0]), [1, 2, 3, 4]);
assert.deepStrictEqual(Array.from(parsedXiph.frames[1]), [5, 6, 7]);
console.log('PASS: Xiph lacing unpacking passed');

// 4. Verify EBML Lacing in parseSimpleBlock
// Flags: 0x80 | (3 << 1) = 0x86
// numFrames - 1 = 1 -> 2 frames
// Frame 1 size VINT: 0x84 (size 4)
// Frame 1: [10, 20, 30, 40]
// Frame 2 (remainder): [50, 60]
const ebmlBlock = new Uint8Array([
  0x82, 0x00, 0x00, 0x86,
  0x01, 0x84,
  10, 20, 30, 40,
  50, 60
]);
const parsedEbml = parseSimpleBlock(ebmlBlock);
assert.ok(parsedEbml);
assert.strictEqual(parsedEbml.frames.length, 2);
assert.deepStrictEqual(Array.from(parsedEbml.frames[0]), [10, 20, 30, 40]);
assert.deepStrictEqual(Array.from(parsedEbml.frames[1]), [50, 60]);
console.log('PASS: EBML lacing unpacking passed');

// 5. Verify MSEController methods exist
const mockVideo = {
  src: '',
  currentTime: 0,
  buffered: {
    length: 1,
    start: () => 0.08,
    end: () => 5.0
  },
  addEventListener: () => {},
  removeEventListener: () => {}
};
const controller = new MSEController(mockVideo);
assert.strictEqual(typeof controller.hasAudioTrack, 'function', 'hasAudioTrack must be a method');
assert.strictEqual(controller.hasAudioTrack(), false, 'hasAudioTrack must be false initially');
assert.strictEqual(typeof controller.bridgeBufferGap, 'function', 'bridgeBufferGap must be a method');

// Test bridgeBufferGap when currentTime is within 0.15s of buffered start
mockVideo.currentTime = 0.00;
controller.bridgeBufferGap();
assert.strictEqual(mockVideo.currentTime, 0.08, 'bridgeBufferGap must advance currentTime to startPts');
console.log('PASS: MSEController hasAudioTrack & bridgeBufferGap checks passed');

controller.destroy();
console.log('ALL M1 VERIFICATION TESTS PASSED SUCCESSFULLY!');
process.exit(0);
