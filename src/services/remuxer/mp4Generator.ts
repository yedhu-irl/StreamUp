/**
 * Pure TypeScript ISO-BMFF (fMP4) Box Generator
 * Builds fragmented MP4 initialization and media segments for MediaSource / SourceBuffer.
 */

// Helper to write a 32-bit big-endian integer into a buffer
export function writeUint32(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// Helper to write a 16-bit big-endian integer
export function writeUint16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

// Helper to create an ISO box: [4 bytes size][4 bytes type][data]
export function createBox(type: string, ...payloads: (Uint8Array | number[])[]): Uint8Array {
  let payloadLen = 0;
  for (const p of payloads) {
    payloadLen += p.length;
  }
  const size = 8 + payloadLen;
  const out = new Uint8Array(size);

  // Write size
  writeUint32(out, 0, size);

  // Write 4-char type
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }

  // Write payloads
  let offset = 8;
  for (const p of payloads) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Full Box: [4 bytes size][4 bytes type][1 byte version][3 bytes flags][data]
export function createFullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: (Uint8Array | number[])[]
): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = version & 0xff;
  header[1] = (flags >>> 16) & 0xff;
  header[2] = (flags >>> 8) & 0xff;
  header[3] = flags & 0xff;
  return createBox(type, header, ...payloads);
}

export interface VideoTrackConfig {
  trackId: number;
  timescale: number;
  width: number;
  height: number;
  codecType?: 'avc' | 'hevc';
  sps?: Uint8Array;
  pps?: Uint8Array;
  codecPrivate?: Uint8Array;
}

export interface AudioTrackConfig {
  trackId: number;
  timescale: number; // e.g. 44100 or 48000
  channelCount: number;
  sampleRate: number;
  audioSpecificConfig?: Uint8Array; // 2-byte AAC config
}

/**
 * Generates the fMP4 'ftyp' box
 */
export function generateFtyp(codecType: 'avc' | 'hevc' = 'avc'): Uint8Array {
  const majorBrand = [0x69, 0x73, 0x6f, 0x6d]; // 'isom'
  const minorVersion = [0x00, 0x00, 0x02, 0x00]; // 512
  const compatibleBrands = codecType === 'hevc' ? [
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x69, 0x73, 0x6f, 0x34, // 'iso4'
    0x68, 0x76, 0x63, 0x31, // 'hvc1'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ] : [
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x69, 0x73, 0x6f, 0x32, // 'iso2'
    0x61, 0x76, 0x63, 0x31, // 'avc1'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ];
  return createBox('ftyp', majorBrand, minorVersion, compatibleBrands);
}

/**
 * Builds avcC box holding SPS and PPS
 */
export function generateAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profileIdc = sps.length > 1 ? sps[1] : 0x64; // High profile default
  const profileCompat = sps.length > 2 ? sps[2] : 0x00;
  const levelIdc = sps.length > 3 ? sps[3] : 0x1f; // Level 3.1

  const header = [
    0x01, // configurationVersion
    profileIdc,
    profileCompat,
    levelIdc,
    0xff, // 11111100 | lengthSizeMinusOne (3 = 4-byte NAL length)
    0xe1, // 11100000 | numOfSequenceParameterSets (1)
    (sps.length >>> 8) & 0xff,
    sps.length & 0xff,
  ];

  const ppsHeader = [
    0x01, // numOfPictureParameterSets (1)
    (pps.length >>> 8) & 0xff,
    pps.length & 0xff,
  ];

  return createBox('avcC', header, sps, ppsHeader, pps);
}

/**
 * Generates fMP4 initialization segment ('ftyp' + 'moov') for H.264 video track
 */
export function generateInitSegment(video: VideoTrackConfig, audio?: AudioTrackConfig): Uint8Array {
  const codecType = video.codecType || 'avc';
  const ftyp = generateFtyp(codecType);

  // mvhd: Movie Header Box
  const mvhd = createFullBox('mvhd', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (video.timescale >>> 24) & 0xff,
    (video.timescale >>> 16) & 0xff,
    (video.timescale >>> 8) & 0xff,
    video.timescale & 0xff, // timescale
    0x00, 0x00, 0x00, 0x00, // duration (0 in fMP4)
    0x00, 0x01, 0x00, 0x00, // preferred rate (1.0)
    0x01, 0x00,             // preferred volume (1.0)
    0x00, 0x00,             // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    // Unity matrix
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    // pre_defined (6 * 4 bytes = 24 bytes of 0)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, (audio ? 0x03 : 0x02), // next_track_ID
  ]);

  // tkhd for video
  const tkhd = createFullBox('tkhd', 0, 0x07, [ // flags 0x07: Track enabled, in movie, in preview
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (video.trackId >>> 24) & 0xff,
    (video.trackId >>> 16) & 0xff,
    (video.trackId >>> 8) & 0xff,
    video.trackId & 0xff,   // track_ID
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // duration
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,             // layer
    0x00, 0x00,             // alternate_group
    0x00, 0x00,             // volume
    0x00, 0x00,             // reserved
    // Unity matrix
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    (video.width >>> 8) & 0xff, video.width & 0xff, 0x00, 0x00,   // width (fixed point 16.16)
    (video.height >>> 8) & 0xff, video.height & 0xff, 0x00, 0x00, // height (fixed point 16.16)
  ]);

  // mdhd
  const mdhd = createFullBox('mdhd', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (video.timescale >>> 24) & 0xff,
    (video.timescale >>> 16) & 0xff,
    (video.timescale >>> 8) & 0xff,
    video.timescale & 0xff, // timescale
    0x00, 0x00, 0x00, 0x00, // duration
    0x55, 0xc4,             // language code 'und'
    0x00, 0x00,             // pre_defined
  ]);

  // hdlr (vide)
  const hdlr = createFullBox('hdlr', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x76, 0x69, 0x64, 0x65, // handler_type: 'vide'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x56, 0x69, 0x64, 0x65, 0x6f, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0x00 // "VideoHandler\0"
  ]);

  // vmhd
  const vmhd = createFullBox('vmhd', 0, 1, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  // dinf -> dref -> url
  const urlBox = createFullBox('url ', 0, 1);
  const dref = createFullBox('dref', 0, 0, [0x00, 0x00, 0x00, 0x01], urlBox);
  const dinf = createBox('dinf', dref);

  // Sample entry inside stsd
  let sampleEntryBox: Uint8Array;
  if (codecType === 'hevc' && video.codecPrivate && video.codecPrivate.length > 0) {
    const hvcC = createBox('hvcC', video.codecPrivate);
    const hvc1Payload = new Uint8Array(78);
    hvc1Payload[6] = 0x00; hvc1Payload[7] = 0x01; // data_reference_index = 1
    writeUint16(hvc1Payload, 24, video.width);
    writeUint16(hvc1Payload, 26, video.height);
    writeUint32(hvc1Payload, 28, 0x00480000);
    writeUint32(hvc1Payload, 32, 0x00480000);
    writeUint16(hvc1Payload, 40, 1);
    hvc1Payload[74] = 0x00; hvc1Payload[75] = 0x18;
    hvc1Payload[76] = 0xff; hvc1Payload[77] = 0xff;
    sampleEntryBox = createBox('hvc1', hvc1Payload, hvcC);
  } else {
    const avcC = generateAvcC(video.sps || new Uint8Array(0), video.pps || new Uint8Array(0));
    const avc1Payload = new Uint8Array(78);
    avc1Payload[6] = 0x00; avc1Payload[7] = 0x01; // data_reference_index = 1
    writeUint16(avc1Payload, 24, video.width);     // visual width
    writeUint16(avc1Payload, 26, video.height);    // visual height
    writeUint32(avc1Payload, 28, 0x00480000);     // horizresolution = 72 dpi
    writeUint32(avc1Payload, 32, 0x00480000);     // vertresolution = 72 dpi
    writeUint16(avc1Payload, 40, 1);              // frame_count = 1
    avc1Payload[74] = 0x00; avc1Payload[75] = 0x18; // depth = 24
    avc1Payload[76] = 0xff; avc1Payload[77] = 0xff; // pre_defined = -1
    sampleEntryBox = createBox('avc1', avc1Payload, avcC);
  }

  const stsd = createFullBox('stsd', 0, 0, [0x00, 0x00, 0x00, 0x01], sampleEntryBox);

  // Empty stts, stsc, stsz, stco for fMP4 init
  const stts = createFullBox('stts', 0, 0, [0x00, 0x00, 0x00, 0x00]);
  const stsc = createFullBox('stsc', 0, 0, [0x00, 0x00, 0x00, 0x00]);
  const stsz = createFullBox('stsz', 0, 0, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const stco = createFullBox('stco', 0, 0, [0x00, 0x00, 0x00, 0x00]);

  const stbl = createBox('stbl', stsd, stts, stsc, stsz, stco);
  const minf = createBox('minf', vmhd, dinf, stbl);
  const mdia = createBox('mdia', mdhd, hdlr, minf);
  const trak = createBox('trak', tkhd, mdia);

  // mvex & trex (tells browser this is fragmented MP4)
  const trex = createFullBox('trex', 0, 0, [
    (video.trackId >>> 24) & 0xff,
    (video.trackId >>> 16) & 0xff,
    (video.trackId >>> 8) & 0xff,
    video.trackId & 0xff,   // track_ID
    0x00, 0x00, 0x00, 0x01, // default_sample_description_index = 1
    0x00, 0x00, 0x03, 0xe8, // default_sample_duration = 1000
    0x00, 0x00, 0x00, 0x00, // default_sample_size
    0x00, 0x01, 0x00, 0x00, // default_sample_flags (dependsOn: 1, isNonSync: 0)
  ]);
  const mvex = createBox('mvex', trex);

  const moov = createBox('moov', mvhd, trak, mvex);

  // Combine ftyp + moov into init segment
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

export interface VideoSample {
  data: Uint8Array;
  duration: number; // in timescale units (e.g. 1000 / 30 for 30fps)
  dts: number;      // decode timestamp
  pts: number;      // presentation timestamp
  isKeyframe: boolean;
}

/**
 * Generates an fMP4 media segment ('moof' + 'mdat') for a set of video samples
 */
export function generateMediaSegment(
  sequenceNumber: number,
  baseMediaDecodeTime: number,
  trackId: number,
  samples: VideoSample[]
): Uint8Array {
  if (samples.length === 0) return new Uint8Array(0);

  // Calculate total mdat size
  let totalDataSize = 0;
  for (const s of samples) {
    totalDataSize += s.data.length;
  }

  // mfhd: Movie Fragment Header Box
  const mfhd = createFullBox('mfhd', 0, 0, [
    (sequenceNumber >>> 24) & 0xff,
    (sequenceNumber >>> 16) & 0xff,
    (sequenceNumber >>> 8) & 0xff,
    sequenceNumber & 0xff,
  ]);

  // tfhd: Track Fragment Header Box
  // flags: 0x020000 = default-base-is-moof
  const tfhd = createFullBox('tfhd', 0, 0x020000, [
    (trackId >>> 24) & 0xff,
    (trackId >>> 16) & 0xff,
    (trackId >>> 8) & 0xff,
    trackId & 0xff,
  ]);

  // tfdt: Track Fragment Base Media Decode Time (64-bit if large)
  let tfdt: Uint8Array;
  if (baseMediaDecodeTime > 0xffffffff) {
    const high = Math.floor(baseMediaDecodeTime / 0x100000000);
    const low = baseMediaDecodeTime >>> 0;
    tfdt = createFullBox('tfdt', 1, 0, [
      (high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff,
      (low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff,
    ]);
  } else {
    tfdt = createFullBox('tfdt', 0, 0, [
      (baseMediaDecodeTime >>> 24) & 0xff,
      (baseMediaDecodeTime >>> 16) & 0xff,
      (baseMediaDecodeTime >>> 8) & 0xff,
      baseMediaDecodeTime & 0xff,
    ]);
  }

  // trun: Track Fragment Run Box
  // flags: 0x0001 (data-offset-present) | 0x0100 (sample-duration-present) | 0x0200 (sample-size-present) | 0x0400 (sample-flags-present) | 0x0800 (sample-composition-time-offsets-present)
  // flags = 0x0f01
  const trunFlags = 0x0f01;
  const sampleCount = samples.length;

  // Placeholder data_offset: will be updated once moof size is calculated
  const trunPayload = new Uint8Array(8 + sampleCount * 16);
  writeUint32(trunPayload, 0, sampleCount);
  writeUint32(trunPayload, 4, 0); // data_offset placeholder

  let pOffset = 8;
  for (const s of samples) {
    const compTimeOffset = s.pts - s.dts;
    const isSync = s.isKeyframe;
    // sample flags: isLeading(2)=0, dependsOn(2)=isSync?2:1, isDependedOn(2)=0, hasRedundancy(2)=0, padding(3)=0, isNonSync(1)=isSync?0:1
    const flags = isSync ? 0x02000000 : 0x01010000;

    writeUint32(trunPayload, pOffset, s.duration);
    writeUint32(trunPayload, pOffset + 4, s.data.length);
    writeUint32(trunPayload, pOffset + 8, flags);
    writeUint32(trunPayload, pOffset + 12, compTimeOffset);
    pOffset += 16;
  }

  const trun = createFullBox('trun', 0, trunFlags, trunPayload);
  const traf = createBox('traf', tfhd, tfdt, trun);
  const moof = createBox('moof', mfhd, traf);

  // Exact data_offset in trun is moof.length + 8 (mdat header size = 8)
  const actualDataOffset = moof.length + 8;

  // Locate data_offset within trun inside moof and overwrite it
  // trun structure inside moof: find 'trun' 4-byte string
  for (let i = 0; i < moof.length - 16; i++) {
    if (
      moof[i] === 0x74 &&
      moof[i + 1] === 0x72 &&
      moof[i + 2] === 0x75 &&
      moof[i + 3] === 0x6e
    ) {
      // trun found at i.
      // i + 0..3: 'trun' (4 bytes)
      // i + 4..7: version (1 byte) + flags (3 bytes) = 4 bytes
      // i + 8..11: sample_count (4 bytes)
      // i + 12..15: data_offset (4 bytes)
      writeUint32(moof, i + 12, actualDataOffset);
      break;
    }
  }

  // Build mdat: [8 bytes mdat header][sample1 data][sample2 data]...
  const mdatHeader = new Uint8Array(8);
  writeUint32(mdatHeader, 0, 8 + totalDataSize);
  mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74; // 'mdat'

  const out = new Uint8Array(moof.length + 8 + totalDataSize);
  out.set(moof, 0);
  out.set(mdatHeader, moof.length);

  let dataCursor = moof.length + 8;
  for (const s of samples) {
    out.set(s.data, dataCursor);
    dataCursor += s.data.length;
  }

  return out;
}

export interface AudioSample {
  data: Uint8Array;
  duration: number; // in timescale units (e.g. 1024 or in ms)
  pts: number;      // presentation timestamp in timescale units
}

export function createDefaultAudioSpecificConfig(sampleRate = 48000, channels = 2): Uint8Array {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  let srIdx = sampleRates.indexOf(sampleRate);
  if (srIdx === -1) srIdx = 3; // 48000 default
  const asc = new Uint8Array(2);
  asc[0] = (2 << 3) | ((srIdx >>> 1) & 0x07);
  asc[1] = ((srIdx & 0x01) << 7) | ((channels & 0x0f) << 3);
  return asc;
}

export function generateEsds(audioSpecificConfig: Uint8Array): Uint8Array {
  const ascLen = audioSpecificConfig.length;
  const dsi = new Uint8Array(2 + ascLen);
  dsi[0] = 0x05; // tag: DecoderSpecificInfo
  dsi[1] = ascLen;
  dsi.set(audioSpecificConfig, 2);

  const dcd = new Uint8Array(15 + dsi.length);
  dcd[0] = 0x04; // tag: DecoderConfigDescriptor
  dcd[1] = 13 + dsi.length;
  dcd[2] = 0x40; // objectTypeIndication: 0x40 (Audio ISO/IEC 14496-3 / AAC)
  dcd[3] = 0x15; // streamType: 0x15 (AudioStream)
  dcd[4] = 0x00; dcd[5] = 0x00; dcd[6] = 0x00; // bufferSizeDB (3 bytes)
  writeUint32(dcd, 7, 0x00018000); // maxBitrate ~98kbps
  writeUint32(dcd, 11, 0x00018000); // avgBitrate
  dcd.set(dsi, 15);

  const sl = new Uint8Array([0x06, 0x01, 0x02]); // SLConfigDescriptor: predefined = 2

  const esd = new Uint8Array(5 + dcd.length + sl.length);
  esd[0] = 0x03; // tag: ES_Descriptor
  esd[1] = 3 + dcd.length + sl.length;
  writeUint16(esd, 2, 1); // ES_ID = 1
  esd[4] = 0x00; // streamPriority = 0
  esd.set(dcd, 5);
  esd.set(sl, 5 + dcd.length);

  return createFullBox('esds', 0, 0, esd);
}

export function generateAudioInitSegment(audio: AudioTrackConfig): Uint8Array {
  const ftyp = generateFtyp('avc');
  const timescale = audio.timescale || audio.sampleRate || 48000;
  const trackId = audio.trackId || 2;
  const sampleRate = audio.sampleRate || 48000;
  const channelCount = audio.channelCount || 2;

  // mvhd: Movie Header Box
  const mvhd = createFullBox('mvhd', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (timescale >>> 24) & 0xff,
    (timescale >>> 16) & 0xff,
    (timescale >>> 8) & 0xff,
    timescale & 0xff,       // timescale
    0x00, 0x00, 0x00, 0x00, // duration (0 in fMP4)
    0x00, 0x01, 0x00, 0x00, // preferred rate (1.0)
    0x01, 0x00,             // preferred volume (1.0)
    0x00, 0x00,             // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    // Unity matrix
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    // pre_defined
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x02, // next_track_ID
  ]);

  // tkhd for audio
  const tkhd = createFullBox('tkhd', 0, 0x07, [ // flags 0x07: Track enabled, in movie, in preview
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (trackId >>> 24) & 0xff,
    (trackId >>> 16) & 0xff,
    (trackId >>> 8) & 0xff,
    trackId & 0xff,         // track_ID
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // duration
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,             // layer
    0x00, 0x00,             // alternate_group
    0x01, 0x00,             // volume (1.0 for audio)
    0x00, 0x00,             // reserved
    // Unity matrix
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // width = 0
    0x00, 0x00, 0x00, 0x00, // height = 0
  ]);

  // mdhd
  const mdhd = createFullBox('mdhd', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (timescale >>> 24) & 0xff,
    (timescale >>> 16) & 0xff,
    (timescale >>> 8) & 0xff,
    timescale & 0xff,       // timescale
    0x00, 0x00, 0x00, 0x00, // duration
    0x55, 0xc4,             // language code 'und'
    0x00, 0x00,             // pre_defined
  ]);

  // hdlr ('soun')
  const hdlr = createFullBox('hdlr', 0, 0, [
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x73, 0x6f, 0x75, 0x6e, // handler_type: 'soun'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x53, 0x6f, 0x75, 0x6e, 0x64, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0x00 // "SoundHandler\0"
  ]);

  // smhd (Sound Media Header Box)
  const smhd = createFullBox('smhd', 0, 0, [0x00, 0x00, 0x00, 0x00]);

  // dinf -> dref -> url
  const urlBox = createFullBox('url ', 0, 1);
  const dref = createFullBox('dref', 0, 0, [0x00, 0x00, 0x00, 0x01], urlBox);
  const dinf = createBox('dinf', dref);

  // mp4a sample entry inside stsd
  const asc = audio.audioSpecificConfig && audio.audioSpecificConfig.length >= 2
    ? audio.audioSpecificConfig
    : createDefaultAudioSpecificConfig(sampleRate, channelCount);
  const esds = generateEsds(asc);

  const mp4aPayload = new Uint8Array(28);
  mp4aPayload[6] = 0x00; mp4aPayload[7] = 0x01; // data_reference_index = 1
  writeUint16(mp4aPayload, 16, channelCount);    // channelcount
  writeUint16(mp4aPayload, 18, 16);              // samplesize = 16-bit
  writeUint32(mp4aPayload, 24, sampleRate << 16); // samplerate (16.16 fixed point)

  const mp4a = createBox('mp4a', mp4aPayload, esds);
  const stsd = createFullBox('stsd', 0, 0, [0x00, 0x00, 0x00, 0x01], mp4a);

  // Empty stts, stsc, stsz, stco
  const stts = createFullBox('stts', 0, 0, [0x00, 0x00, 0x00, 0x00]);
  const stsc = createFullBox('stsc', 0, 0, [0x00, 0x00, 0x00, 0x00]);
  const stsz = createFullBox('stsz', 0, 0, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const stco = createFullBox('stco', 0, 0, [0x00, 0x00, 0x00, 0x00]);

  const stbl = createBox('stbl', stsd, stts, stsc, stsz, stco);
  const minf = createBox('minf', smhd, dinf, stbl);
  const mdia = createBox('mdia', mdhd, hdlr, minf);
  const trak = createBox('trak', tkhd, mdia);

  // mvex & trex for audio
  const trex = createFullBox('trex', 0, 0, [
    (trackId >>> 24) & 0xff,
    (trackId >>> 16) & 0xff,
    (trackId >>> 8) & 0xff,
    trackId & 0xff,         // track_ID
    0x00, 0x00, 0x00, 0x01, // default_sample_description_index = 1
    0x00, 0x00, 0x04, 0x00, // default_sample_duration = 1024
    0x00, 0x00, 0x00, 0x00, // default_sample_size
    0x00, 0x00, 0x00, 0x00, // default_sample_flags
  ]);
  const mvex = createBox('mvex', trex);

  const moov = createBox('moov', mvhd, trak, mvex);

  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

export function generateAudioMediaSegment(
  sequenceNumber: number,
  baseMediaDecodeTime: number,
  trackId: number,
  samples: AudioSample[]
): Uint8Array {
  if (samples.length === 0) return new Uint8Array(0);

  let totalDataSize = 0;
  for (const s of samples) {
    totalDataSize += s.data.length;
  }

  const mfhd = createFullBox('mfhd', 0, 0, [
    (sequenceNumber >>> 24) & 0xff,
    (sequenceNumber >>> 16) & 0xff,
    (sequenceNumber >>> 8) & 0xff,
    sequenceNumber & 0xff,
  ]);

  const tfhd = createFullBox('tfhd', 0, 0x020000, [
    (trackId >>> 24) & 0xff,
    (trackId >>> 16) & 0xff,
    (trackId >>> 8) & 0xff,
    trackId & 0xff,
  ]);

  let tfdt: Uint8Array;
  if (baseMediaDecodeTime > 0xffffffff) {
    const high = Math.floor(baseMediaDecodeTime / 0x100000000);
    const low = baseMediaDecodeTime >>> 0;
    tfdt = createFullBox('tfdt', 1, 0, [
      (high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff,
      (low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff,
    ]);
  } else {
    tfdt = createFullBox('tfdt', 0, 0, [
      (baseMediaDecodeTime >>> 24) & 0xff,
      (baseMediaDecodeTime >>> 16) & 0xff,
      (baseMediaDecodeTime >>> 8) & 0xff,
      baseMediaDecodeTime & 0xff,
    ]);
  }

  // flags: data-offset-present (0x0001) | sample-duration-present (0x0100) | sample-size-present (0x0200) = 0x0301
  const trunFlags = 0x0301;
  const sampleCount = samples.length;

  const trunPayload = new Uint8Array(8 + sampleCount * 8);
  writeUint32(trunPayload, 0, sampleCount);
  writeUint32(trunPayload, 4, 0); // placeholder data_offset

  let pOffset = 8;
  for (const s of samples) {
    writeUint32(trunPayload, pOffset, s.duration);
    writeUint32(trunPayload, pOffset + 4, s.data.length);
    pOffset += 8;
  }

  const trun = createFullBox('trun', 0, trunFlags, trunPayload);
  const traf = createBox('traf', tfhd, tfdt, trun);
  const moof = createBox('moof', mfhd, traf);

  const actualDataOffset = moof.length + 8;

  for (let i = 0; i < moof.length - 16; i++) {
    if (
      moof[i] === 0x74 &&
      moof[i + 1] === 0x72 &&
      moof[i + 2] === 0x75 &&
      moof[i + 3] === 0x6e
    ) {
      writeUint32(moof, i + 12, actualDataOffset);
      break;
    }
  }

  const mdatHeader = new Uint8Array(8);
  writeUint32(mdatHeader, 0, 8 + totalDataSize);
  mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74; // 'mdat'

  const out = new Uint8Array(moof.length + 8 + totalDataSize);
  out.set(moof, 0);
  out.set(mdatHeader, moof.length);

  let dataCursor = moof.length + 8;
  for (const s of samples) {
    out.set(s.data, dataCursor);
    dataCursor += s.data.length;
  }

  return out;
}

