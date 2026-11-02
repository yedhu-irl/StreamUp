/**
 * tests/infra/synthetic-ebml.ts
 * Generates bit-accurate Matroska / EBML binary structures for testing demuxer,
 * transmuxer, and Web Worker pipelines.
 */

export interface SyntheticEbmlOptions {
  durationSec?: number;
  videoCodec?: 'V_MPEG4/ISO/AVC' | 'V_MPEGH/ISO/HEVC';
  audioCodec?: 'A_AAC' | 'A_AC3' | 'A_EAC3' | 'A_DTS' | 'None';
  initialClusterPtsMs?: number;
  includeLacedAudio?: boolean;
  lacedFramesCount?: number;
  width?: number;
  height?: number;
}

// Helper to encode EBML variable-size integer (VINT)
export function encodeVint(value: number, minLength = 1): Uint8Array {
  if (value < 0) throw new Error('VINT cannot be negative');
  let length = minLength;
  if (value < 127 && minLength <= 1) length = 1;
  else if (value < 16383 && minLength <= 2) length = 2;
  else if (value < 2097151 && minLength <= 3) length = 3;
  else if (value < 268435455 && minLength <= 4) length = 4;
  else length = Math.max(minLength, 8);

  const bytes = new Uint8Array(length);
  const marker = 1 << (7 - (length - 1));
  let remaining = value;

  for (let i = length - 1; i > 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = remaining >>> 8;
  }
  bytes[0] = marker | (remaining & (marker - 1));
  return bytes;
}

export function encodeEbmlElement(id: number, payload: Uint8Array): Uint8Array {
  // Convert ID to bytes
  let idBytes: number[] = [];
  let temp = id;
  while (temp > 0) {
    idBytes.unshift(temp & 0xff);
    temp = temp >>> 8;
  }
  const vintSize = encodeVint(payload.length);
  const totalLen = idBytes.length + vintSize.length + payload.length;
  const result = new Uint8Array(totalLen);
  result.set(idBytes, 0);
  result.set(vintSize, idBytes.length);
  result.set(payload, idBytes.length + vintSize.length);
  return result;
}

export function encodeUint(val: number): Uint8Array {
  if (val === 0) return new Uint8Array([0]);
  let temp = val;
  const bytes: number[] = [];
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp = temp >>> 8;
  }
  return new Uint8Array(bytes);
}

export function encodeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function encodeFloat(val: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, false);
  return new Uint8Array(buf);
}

/**
 * Builds a complete synthetic Matroska byte stream containing Header, Tracks, and Clusters.
 */
export function buildSyntheticMkv(options: SyntheticEbmlOptions = {}): Uint8Array {
  const {
    durationSec = 60,
    videoCodec = 'V_MPEG4/ISO/AVC',
    audioCodec = 'A_AAC',
    initialClusterPtsMs = 0,
    includeLacedAudio = false,
    lacedFramesCount = 4,
    width = 1920,
    height = 1080,
  } = options;

  // 1. EBML Header
  const ebmlVersion = encodeEbmlElement(0x4286, encodeUint(1));
  const ebmlReadVersion = encodeEbmlElement(0x42f7, encodeUint(1));
  const docType = encodeEbmlElement(0x4282, encodeString('matroska'));
  const docTypeVersion = encodeEbmlElement(0x4287, encodeUint(4));
  const docTypeReadVersion = encodeEbmlElement(0x4285, encodeUint(2));

  const ebmlHeaderPayload = concatArrays([ebmlVersion, ebmlReadVersion, docType, docTypeVersion, docTypeReadVersion]);
  const ebmlHeader = encodeEbmlElement(0x1a45dfa3, ebmlHeaderPayload);

  // 2. Info Element
  const timecodeScale = encodeEbmlElement(0x2ad7b1, encodeUint(1_000_000)); // 1ms per tick
  const duration = encodeEbmlElement(0x4489, encodeFloat(durationSec * 1000));
  const muxingApp = encodeEbmlElement(0x4d80, encodeString('StreamUpSyntheticMuxer'));
  const infoPayload = concatArrays([timecodeScale, duration, muxingApp]);
  const infoElement = encodeEbmlElement(0x1549a966, infoPayload);

  // 3. Tracks Element
  const trackEntries: Uint8Array[] = [];

  // Video Track (TrackNumber 1)
  const vTrackNum = encodeEbmlElement(0xd7, encodeUint(1));
  const vTrackUID = encodeEbmlElement(0x73c5, encodeUint(1001));
  const vTrackType = encodeEbmlElement(0x83, encodeUint(1)); // 1 = Video
  const vCodecId = encodeEbmlElement(0x86, encodeString(videoCodec));

  // Video Settings
  const pixelWidth = encodeEbmlElement(0xb0, encodeUint(width));
  const pixelHeight = encodeEbmlElement(0xba, encodeUint(height));
  const videoSettings = encodeEbmlElement(0xe0, concatArrays([pixelWidth, pixelHeight]));

  // Fake SPS/PPS Annex-B CodecPrivate for AVC
  const fakeSpsPps = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x84,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x38, 0x80,
  ]);
  const vCodecPrivate = encodeEbmlElement(0x63a2, fakeSpsPps);
  const vTrackPayload = concatArrays([vTrackNum, vTrackUID, vTrackType, vCodecId, videoSettings, vCodecPrivate]);
  trackEntries.push(encodeEbmlElement(0xae, vTrackPayload));

  // Audio Track (TrackNumber 2) if not None
  if (audioCodec !== 'None') {
    const aTrackNum = encodeEbmlElement(0xd7, encodeUint(2));
    const aTrackUID = encodeEbmlElement(0x73c5, encodeUint(2001));
    const aTrackType = encodeEbmlElement(0x83, encodeUint(2)); // 2 = Audio
    const aCodecId = encodeEbmlElement(0x86, encodeString(audioCodec));

    const samplingFreq = encodeEbmlElement(0xb5, encodeFloat(48000));
    const channels = encodeEbmlElement(0x9f, encodeUint(2));
    const audioSettings = encodeEbmlElement(0xe1, concatArrays([samplingFreq, channels]));

    // AAC AudioSpecificConfig CodecPrivate: 48kHz stereo LC (0x11, 0x90)
    const aCodecPrivate = encodeEbmlElement(0x63a2, new Uint8Array([0x11, 0x90]));
    const aTrackPayload = concatArrays([aTrackNum, aTrackUID, aTrackType, aCodecId, audioSettings, aCodecPrivate]);
    trackEntries.push(encodeEbmlElement(0xae, aTrackPayload));
  }

  const tracksElement = encodeEbmlElement(0x1654ae6b, concatArrays(trackEntries));

  // 4. Clusters
  const clusters: Uint8Array[] = [];
  const clusterTime = encodeEbmlElement(0xe7, encodeUint(initialClusterPtsMs));

  // Video SimpleBlock (Track 1, Keyframe, relativeTime = 0)
  const videoPayload = new Uint8Array([0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x80, 0x00, 0x00]); // Fake IDR NALU
  const videoBlock = buildSimpleBlock(1, 0, true, 0, videoPayload);

  // Audio SimpleBlock (Track 2)
  let audioBlock: Uint8Array | null = null;
  if (audioCodec !== 'None') {
    if (includeLacedAudio) {
      // EBML Lacing (lacing flag = 3 or Xiph = 1)
      audioBlock = buildLacedSimpleBlock(2, 0, lacedFramesCount);
    } else {
      const rawAudioFrame = new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00]);
      audioBlock = buildSimpleBlock(2, 0, true, 0, rawAudioFrame);
    }
  }

  const clusterItems = [clusterTime, videoBlock];
  if (audioBlock) clusterItems.push(audioBlock);

  const clusterPayload = concatArrays(clusterItems);
  const cluster1 = encodeEbmlElement(0x1f43b675, clusterPayload);
  clusters.push(cluster1);

  // Segment Element (Container for Info, Tracks, Clusters)
  // Segment size is typically unknown (all 1s in VINT) or known
  const segmentPayload = concatArrays([infoElement, tracksElement, ...clusters]);
  const segmentElement = encodeEbmlElement(0x18538067, segmentPayload);

  return concatArrays([ebmlHeader, segmentElement]);
}

/**
 * Builds a single Matroska SimpleBlock element.
 */
export function buildSimpleBlock(
  trackNumber: number,
  relativeTimeMs: number,
  isKeyframe: boolean,
  lacingMode: number, // 0 = none, 1 = Xiph, 2 = fixed, 3 = EBML
  payload: Uint8Array
): Uint8Array {
  const trackVint = encodeVint(trackNumber);
  const headerLen = trackVint.length + 2 + 1; // track + time(2) + flags(1)
  const block = new Uint8Array(headerLen + payload.length);

  let offset = 0;
  block.set(trackVint, offset);
  offset += trackVint.length;

  // Relative Time (int16 big-endian)
  block[offset++] = (relativeTimeMs >> 8) & 0xff;
  block[offset++] = relativeTimeMs & 0xff;

  // Flags: bit 7 = Keyframe, bits 1-2 = Lacing
  let flags = 0;
  if (isKeyframe) flags |= 0x80;
  flags |= (lacingMode & 0x03) << 1;
  block[offset++] = flags;

  // Payload
  block.set(payload, offset);

  return encodeEbmlElement(0xa3, block);
}

/**
 * Builds a SimpleBlock with Xiph or EBML laced audio frames.
 */
export function buildLacedSimpleBlock(
  trackNumber: number,
  relativeTimeMs: number,
  framesCount: number
): Uint8Array {
  // Lacing = 1 (Xiph) or 3 (EBML)
  const lacingMode = 1; // Xiph lacing
  const frameData = [
    new Uint8Array([0x11, 0x22, 0x33, 0x44]),
    new Uint8Array([0x55, 0x66, 0x77, 0x88]),
    new Uint8Array([0x99, 0xaa, 0xbb, 0xcc]),
  ].slice(0, framesCount);

  // Xiph lacing header: frameCount - 1, followed by sizes of first n-1 frames
  const lacingHeader: number[] = [frameData.length - 1];
  for (let i = 0; i < frameData.length - 1; i++) {
    let size = frameData[i].length;
    while (size >= 255) {
      lacingHeader.push(255);
      size -= 255;
    }
    lacingHeader.push(size);
  }

  const payloadParts = [new Uint8Array(lacingHeader), ...frameData];
  const lacedPayload = concatArrays(payloadParts);

  return buildSimpleBlock(trackNumber, relativeTimeMs, true, lacingMode, lacedPayload);
}

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

