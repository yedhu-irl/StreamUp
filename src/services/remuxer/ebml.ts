/**
 * Pure TypeScript Matroska (EBML) Parser
 * Extracts Tracks, SPS/PPS, Cues (seek index), and Cluster SimpleBlocks.
 */

// EBML Element IDs
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  EBML_VERSION: 0x4286,
  EBML_READ_VERSION: 0x42f7,
  EBML_MAX_ID_LENGTH: 0x42f2,
  EBML_MAX_SIZE_LENGTH: 0x42f3,
  DOC_TYPE: 0x4282,
  DOC_TYPE_VERSION: 0x4287,
  DOC_TYPE_READ_VERSION: 0x4285,

  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,

  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TITLE: 0x7ba9,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,

  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_UID: 0x73c5,
  TRACK_TYPE: 0x83,
  FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa,
  FLAG_LACING: 0x9c,
  DEFAULT_DURATION: 0x23e383,
  NAME: 0x536e,
  LANGUAGE: 0x22b59c,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CODEC_NAME: 0x258688,

  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  DISPLAY_WIDTH: 0x54b0,
  DISPLAY_HEIGHT: 0x54ba,

  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  OUTPUT_SAMPLING_FREQUENCY: 0x78b5,
  CHANNELS: 0x9f,
  BIT_DEPTH: 0x6264,

  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
  CUE_BLOCK_NUMBER: 0x5378,

  CLUSTER: 0x1f43b675,
  TIME_CODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
} as const;

export interface EBMLVint {
  value: number;
  length: number;
}

/**
 * Reads an EBML Element ID from a buffer.
 * In EBML IDs, the leading length descriptor bits remain part of the ID.
 */
export function readElementId(data: Uint8Array, offset: number): EBMLVint | null {
  if (offset >= data.length) return null;
  const firstByte = data[offset];
  if (firstByte === 0) return null; // Invalid ID

  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(firstByte & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 4 || offset + length > data.length) return null;

  let id = 0;
  for (let i = 0; i < length; i++) {
    id = (id << 8) | data[offset + i];
  }
  return { value: id >>> 0, length };
}

/**
 * Reads an EBML Data Size VINT from a buffer.
 * In EBML data sizes, the leading length bit is masked off.
 * Returns -1 for unknown / indefinite size.
 */
export function readDataSize(data: Uint8Array, offset: number): EBMLVint | null {
  if (offset >= data.length) return null;
  const firstByte = data[offset];
  if (firstByte === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(firstByte & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || offset + length > data.length) return null;

  let size = firstByte & (mask - 1);
  for (let i = 1; i < length; i++) {
    size = size * 256 + data[offset + i];
  }

  let isUnknown = (firstByte & (mask - 1)) === (mask - 1);
  if (isUnknown) {
    for (let i = 1; i < length; i++) {
      if (data[offset + i] !== 0xff) {
        isUnknown = false;
        break;
      }
    }
  }
  return { value: isUnknown ? -1 : size, length };
}

/**
 * Reads an unsigned integer of specified length (1 to 8 bytes)
 */
export function readUint(data: Uint8Array, offset: number, length: number): number {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = val * 256 + data[offset + i];
  }
  return val;
}

/**
 * Reads a big-endian float (4 or 8 bytes)
 */
export function readFloat(data: Uint8Array, offset: number, length: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  if (length === 4) return view.getFloat32(0, false);
  if (length === 8) return view.getFloat64(0, false);
  return 0;
}

/**
 * Reads an ASCII or UTF-8 string
 */
export function readString(data: Uint8Array, offset: number, length: number): string {
  const slice = data.subarray(offset, offset + length);
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(slice).replace(/\0+$/, '');
}

export interface VideoTrack {
  trackNumber: number;
  trackType: number; // 1 = video
  codecId: string;   // 'V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC', 'V_VP9', etc.
  width: number;
  height: number;
  codecPrivate?: Uint8Array;
  sps?: Uint8Array;
  pps?: Uint8Array;
  defaultDuration?: number; // nanoseconds per frame
}

export interface AudioTrack {
  trackNumber: number;
  trackType: number; // 2 = audio
  codecId: string;   // 'A_AAC', 'A_AC3', 'A_EAC3', 'A_DTS', 'A_OPUS', etc.
  channels: number;
  samplingFrequency: number;
  bitDepth?: number;
  codecPrivate?: Uint8Array;
}

export interface SubtitleTrackInfo {
  trackNumber: number;
  trackType: number; // 17 = subtitle
  codecId: string;   // 'S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT', etc.
  language?: string;
  name?: string;
  isDefault?: boolean;
  isForced?: boolean;
}

export interface CueEntry {
  timeMs: number;
  trackNumber: number;
  clusterOffset: number; // relative to segment data start
}

export interface MatroskaMetadata {
  docType: string;
  timecodeScale: number; // nanoseconds per tick (usually 1,000,000)
  durationSec: number;
  segmentDataOffset: number; // absolute file offset where Segment payload starts
  videoTracks: VideoTrack[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrackInfo[];
  cues: CueEntry[];
}

export interface ParsedBlock {
  trackNumber: number;
  relativeTime: number; // relative to cluster timecode
  isKeyframe: boolean;
  data: Uint8Array;
  frames?: Uint8Array[]; // Unpacked laced frames
  durationMs?: number;
}

/**
 * Parses AVCDecoderConfigurationRecord or Annex B from CodecPrivate
 */
export function extractAvcParameters(codecPrivate: Uint8Array): { sps?: Uint8Array; pps?: Uint8Array } {
  if (!codecPrivate || codecPrivate.length < 4) return {};

  // Case 1: AVCDecoderConfigurationRecord (starts with 0x01)
  if (codecPrivate[0] === 0x01 && codecPrivate.length >= 7) {
    let offset = 5;
    const numSps = codecPrivate[offset++] & 0x1f;
    let sps: Uint8Array | undefined;
    for (let i = 0; i < numSps && offset + 2 <= codecPrivate.length; i++) {
      const spsLen = (codecPrivate[offset] << 8) | codecPrivate[offset + 1];
      offset += 2;
      if (offset + spsLen <= codecPrivate.length) {
        sps = codecPrivate.slice(offset, offset + spsLen);
        offset += spsLen;
      }
    }

    let pps: Uint8Array | undefined;
    if (offset < codecPrivate.length) {
      const numPps = codecPrivate[offset++];
      for (let i = 0; i < numPps && offset + 2 <= codecPrivate.length; i++) {
        const ppsLen = (codecPrivate[offset] << 8) | codecPrivate[offset + 1];
        offset += 2;
        if (offset + ppsLen <= codecPrivate.length) {
          pps = codecPrivate.slice(offset, offset + ppsLen);
          offset += ppsLen;
        }
      }
    }
    return { sps, pps };
  }

  // Case 2: Annex B byte stream (0x00 0x00 0x00 0x01 or 0x00 0x00 0x01)
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  const nalUnits = splitAnnexBNals(codecPrivate);
  for (const nal of nalUnits) {
    const nalType = nal[0] & 0x1f;
    if (nalType === 7 && !sps) sps = nal;
    if (nalType === 8 && !pps) pps = nal;
  }
  return { sps, pps };
}

/**
 * Splits Annex B byte stream into separate NAL units
 */
export function splitAnnexBNals(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;

  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let prefixLen = 0;
      if (data[i + 2] === 1) {
        prefixLen = 3;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        prefixLen = 4;
      }

      if (prefixLen > 0) {
        if (start !== -1) {
          nals.push(data.subarray(start, i));
        }
        start = i + prefixLen;
        i += prefixLen - 1;
      }
    }
  }

  if (start !== -1 && start < data.length) {
    nals.push(data.subarray(start));
  }
  return nals;
}

/**
 * Checks if the buffer is already valid AVCC format (consecutive 4-byte big-endian NAL units).
 */
export function isAvccFormat(data: Uint8Array): boolean {
  if (data.length < 5) return false;
  let offset = 0;
  while (offset + 4 < data.length) {
    const len = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    if (len <= 0 || offset + 4 + len > data.length) {
      return false;
    }
    const nalHeader = data[offset + 4];
    if ((nalHeader & 0x80) !== 0) {
      return false; // forbidden_zero_bit must be 0 in valid NAL
    }
    offset += 4 + len;
  }
  return offset === data.length;
}

/**
 * Converts Annex B NAL units to AVCC 4-byte length-prefixed format
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  // If already AVCC (valid 4-byte length-prefixed NALUs), return directly
  if (isAvccFormat(data)) {
    return data;
  }

  const nals = splitAnnexBNals(data);
  if (nals.length === 0) {
    // Treat whole data as one NAL
    const out = new Uint8Array(4 + data.length);
    out[0] = (data.length >>> 24) & 0xff;
    out[1] = (data.length >>> 16) & 0xff;
    out[2] = (data.length >>> 8) & 0xff;
    out[3] = data.length & 0xff;
    out.set(data, 4);
    return out;
  }

  let totalSize = 0;
  for (const n of nals) {
    totalSize += 4 + n.length;
  }
  const out = new Uint8Array(totalSize);
  let cursor = 0;
  for (const n of nals) {
    out[cursor] = (n.length >>> 24) & 0xff;
    out[cursor + 1] = (n.length >>> 16) & 0xff;
    out[cursor + 2] = (n.length >>> 8) & 0xff;
    out[cursor + 3] = n.length & 0xff;
    cursor += 4;
    out.set(n, cursor);
    cursor += n.length;
  }
  return out;
}

/**
 * Parses EBML Header and Segment info/tracks from initial file buffer
 */
export function parseMatroskaHeader(data: Uint8Array): MatroskaMetadata | null {
  let offset = 0;

  // 1. EBML Header
  const ebmlElem = readElementId(data, offset);
  if (!ebmlElem || ebmlElem.value !== EBML_ID.EBML) return null;
  offset += ebmlElem.length;

  const ebmlSize = readDataSize(data, offset);
  if (!ebmlSize) return null;
  offset += ebmlSize.length;

  let docType = 'matroska';
  const ebmlEnd = offset + ebmlSize.value;
  while (offset < ebmlEnd && offset < data.length) {
    const el = readElementId(data, offset);
    if (!el) break;
    offset += el.length;
    const sz = readDataSize(data, offset);
    if (!sz) break;
    offset += sz.length;

    if (el.value === EBML_ID.DOC_TYPE) {
      docType = readString(data, offset, sz.value);
    }
    offset += sz.value;
  }

  // 2. Segment
  const segElem = readElementId(data, offset);
  if (!segElem || segElem.value !== EBML_ID.SEGMENT) return null;
  offset += segElem.length;

  const segSize = readDataSize(data, offset);
  if (!segSize) return null;
  offset += segSize.length;

  const segmentDataOffset = offset;
  let timecodeScale = 1_000_000; // default 1ms
  let durationSec = 0;
  const videoTracks: VideoTrack[] = [];
  const audioTracks: AudioTrack[] = [];
  const subtitleTracks: SubtitleTrackInfo[] = [];
  const cues: CueEntry[] = [];

  // Parse Segment top-level elements (Info, Tracks, Cues)
  while (offset < data.length) {
    const el = readElementId(data, offset);
    if (!el) break;
    const elId = el.value;
    const elHeaderLen = el.length;

    const sz = readDataSize(data, offset + elHeaderLen);
    if (!sz) break;
    const szLen = sz.length;
    const payloadOffset = offset + elHeaderLen + szLen;
    const payloadSize = sz.value;

    if (elId === EBML_ID.CLUSTER) {
      // Reached media clusters - stop header parsing
      break;
    }

    if (payloadSize < 0 || payloadOffset + payloadSize > data.length) {
      // Reached boundary of current buffer
      break;
    }

    if (elId === EBML_ID.INFO) {
      let infoOff = payloadOffset;
      const infoEnd = payloadOffset + payloadSize;
      while (infoOff < infoEnd) {
        const iEl = readElementId(data, infoOff);
        if (!iEl) break;
        infoOff += iEl.length;
        const iSz = readDataSize(data, infoOff);
        if (!iSz) break;
        infoOff += iSz.length;

        if (iEl.value === EBML_ID.TIMECODE_SCALE) {
          timecodeScale = readUint(data, infoOff, iSz.value);
        } else if (iEl.value === EBML_ID.DURATION) {
          const rawDuration = readFloat(data, infoOff, iSz.value);
          durationSec = (rawDuration * timecodeScale) / 1_000_000_000;
        }
        infoOff += iSz.value;
      }
    } else if (elId === EBML_ID.TRACKS) {
      let trkOff = payloadOffset;
      const trkEnd = payloadOffset + payloadSize;
      while (trkOff < trkEnd) {
        const tEl = readElementId(data, trkOff);
        if (!tEl) break;
        trkOff += tEl.length;
        const tSz = readDataSize(data, trkOff);
        if (!tSz) break;
        trkOff += tSz.length;

        if (tEl.value === EBML_ID.TRACK_ENTRY) {
          const track = parseTrackEntry(data, trkOff, tSz.value);
          if (track) {
            if (track.type === 'video') videoTracks.push(track.track as VideoTrack);
            else if (track.type === 'audio') audioTracks.push(track.track as AudioTrack);
            else if (track.type === 'subtitle') subtitleTracks.push(track.track as SubtitleTrackInfo);
          }
        }
        trkOff += tSz.value;
      }
    } else if (elId === EBML_ID.CUES) {
      parseCues(data, payloadOffset, payloadSize, cues);
    }

    offset = payloadOffset + payloadSize;
  }

  return {
    docType,
    timecodeScale,
    durationSec,
    segmentDataOffset,
    videoTracks,
    audioTracks,
    subtitleTracks,
    cues,
  };
}

function parseTrackEntry(
  data: Uint8Array,
  start: number,
  size: number
): { type: 'video' | 'audio' | 'subtitle'; track: VideoTrack | AudioTrack | SubtitleTrackInfo } | null {
  let off = start;
  const end = start + size;

  let trackNumber = 1;
  let trackType = 1; // 1 = video, 2 = audio, 17 = subtitle
  let codecId = '';
  let name = '';
  let language = '';
  let isDefault = false;
  let isForced = false;
  let defaultDuration: number | undefined;
  let codecPrivate: Uint8Array | undefined;

  let width = 0;
  let height = 0;

  let channels = 2;
  let samplingFrequency = 48000;
  let bitDepth: number | undefined;

  while (off < end) {
    const el = readElementId(data, off);
    if (!el) break;
    off += el.length;
    const sz = readDataSize(data, off);
    if (!sz) break;
    off += sz.length;

    if (el.value === EBML_ID.TRACK_NUMBER) {
      trackNumber = readUint(data, off, sz.value);
    } else if (el.value === EBML_ID.TRACK_TYPE) {
      trackType = readUint(data, off, sz.value);
    } else if (el.value === EBML_ID.CODEC_ID) {
      codecId = readString(data, off, sz.value);
    } else if (el.value === EBML_ID.NAME) {
      name = readString(data, off, sz.value);
    } else if (el.value === EBML_ID.LANGUAGE) {
      language = readString(data, off, sz.value);
    } else if (el.value === EBML_ID.FLAG_DEFAULT) {
      isDefault = readUint(data, off, sz.value) === 1;
    } else if (el.value === EBML_ID.FLAG_FORCED) {
      isForced = readUint(data, off, sz.value) === 1;
    } else if (el.value === EBML_ID.DEFAULT_DURATION) {
      defaultDuration = readUint(data, off, sz.value);
    } else if (el.value === EBML_ID.CODEC_PRIVATE) {
      codecPrivate = data.slice(off, off + sz.value);
    } else if (el.value === EBML_ID.VIDEO) {
      let vOff = off;
      const vEnd = off + sz.value;
      while (vOff < vEnd) {
        const vel = readElementId(data, vOff);
        if (!vel) break;
        vOff += vel.length;
        const vsz = readDataSize(data, vOff);
        if (!vsz) break;
        vOff += vsz.length;

        if (vel.value === EBML_ID.PIXEL_WIDTH) {
          width = readUint(data, vOff, vsz.value);
        } else if (vel.value === EBML_ID.PIXEL_HEIGHT) {
          height = readUint(data, vOff, vsz.value);
        }
        vOff += vsz.value;
      }
    } else if (el.value === EBML_ID.AUDIO) {
      let aOff = off;
      const aEnd = off + sz.value;
      while (aOff < aEnd) {
        const ael = readElementId(data, aOff);
        if (!ael) break;
        aOff += ael.length;
        const asz = readDataSize(data, aOff);
        if (!asz) break;
        aOff += asz.length;

        if (ael.value === EBML_ID.CHANNELS) {
          channels = readUint(data, aOff, asz.value);
        } else if (ael.value === EBML_ID.SAMPLING_FREQUENCY) {
          samplingFrequency = readFloat(data, aOff, asz.value);
        } else if (ael.value === EBML_ID.BIT_DEPTH) {
          bitDepth = readUint(data, aOff, asz.value);
        }
        aOff += asz.value;
      }
    }

    off += sz.value;
  }

  if (trackType === 1) {
    const isHevc = codecId.includes('HEVC') || codecId.includes('H265') || codecId === 'V_MPEGH/ISO/HEVC';
    const { sps, pps } = (!isHevc && codecPrivate) ? extractAvcParameters(codecPrivate) : {};
    return {
      type: 'video',
      track: {
        trackNumber,
        trackType,
        codecId,
        width,
        height,
        codecPrivate,
        sps,
        pps,
        defaultDuration,
      },
    };
  } else if (trackType === 2) {
    return {
      type: 'audio',
      track: {
        trackNumber,
        trackType,
        codecId,
        channels,
        samplingFrequency,
        bitDepth,
        codecPrivate,
      },
    };
  } else if (trackType === 17 || codecId.startsWith('S_')) {
    return {
      type: 'subtitle',
      track: {
        trackNumber,
        trackType: 17,
        codecId,
        language: language || 'und',
        name: name || undefined,
        isDefault,
        isForced,
      },
    };
  }

  return null;
}

export function parseCues(data: Uint8Array, start: number, size: number, outCues: CueEntry[]) {
  let off = start;
  const end = start + size;

  while (off < end) {
    const el = readElementId(data, off);
    if (!el) break;
    off += el.length;
    const sz = readDataSize(data, off);
    if (!sz) break;
    off += sz.length;

    if (el.value === EBML_ID.CUE_POINT) {
      let cpOff = off;
      const cpEnd = off + sz.value;
      let timeMs = 0;
      let trackNum = 1;
      let clusterOff = 0;

      while (cpOff < cpEnd) {
        const cpel = readElementId(data, cpOff);
        if (!cpel) break;
        cpOff += cpel.length;
        const cpsz = readDataSize(data, cpOff);
        if (!cpsz) break;
        cpOff += cpsz.length;

        if (cpel.value === EBML_ID.CUE_TIME) {
          timeMs = readUint(data, cpOff, cpsz.value);
        } else if (cpel.value === EBML_ID.CUE_TRACK_POSITIONS) {
          let tpOff = cpOff;
          const tpEnd = cpOff + cpsz.value;
          while (tpOff < tpEnd) {
            const tpel = readElementId(data, tpOff);
            if (!tpel) break;
            tpOff += tpel.length;
            const tpsz = readDataSize(data, tpOff);
            if (!tpsz) break;
            tpOff += tpsz.length;

            if (tpel.value === EBML_ID.CUE_TRACK) {
              trackNum = readUint(data, tpOff, tpsz.value);
            } else if (tpel.value === EBML_ID.CUE_CLUSTER_POSITION) {
              clusterOff = readUint(data, tpOff, tpsz.value);
            }
            tpOff += tpsz.value;
          }
        }
        cpOff += cpsz.value;
      }

      outCues.push({
        timeMs,
        trackNumber: trackNum,
        clusterOffset: clusterOff,
      });
    }

    off += sz.value;
  }
}

/**
 * Parses a single SimpleBlock or Block payload from a Matroska Cluster
 */
export function parseSimpleBlock(payload: Uint8Array): ParsedBlock | null {
  if (payload.length < 4) return null;

  // 1. Track Number (EBML VINT with mask stripped)
  const firstByte = payload[0];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(firstByte & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 4 || payload.length < length + 3) return null;

  let trackNumber = firstByte & (mask - 1);
  for (let i = 1; i < length; i++) {
    trackNumber = trackNumber * 256 + payload[i];
  }

  // 2. Relative Timecode (int16 signed)
  let offset = length;
  const timeHigh = payload[offset++];
  const timeLow = payload[offset++];
  let relativeTime = (timeHigh << 8) | timeLow;
  if (relativeTime & 0x8000) {
    relativeTime -= 0x10000; // Sign extend negative offset
  }

  // 3. Flags
  const flags = payload[offset++];
  const isKeyframe = (flags & 0x80) !== 0;
  const lacing = (flags & 0x06) >> 1;

  if (lacing === 0) {
    const data = payload.subarray(offset);
    return {
      trackNumber,
      relativeTime,
      isKeyframe,
      data,
      frames: [data],
    };
  }

  // Handle Laced Frames
  if (offset >= payload.length) return null;
  const numFrames = payload[offset++] + 1;
  if (numFrames === 1) {
    const data = payload.subarray(offset);
    return {
      trackNumber,
      relativeTime,
      isKeyframe,
      data,
      frames: [data],
    };
  }

  const frameSizes: number[] = new Array(numFrames);
  let totalKnownSize = 0;

  if (lacing === 1) {
    // Xiph Lacing
    for (let i = 0; i < numFrames - 1; i++) {
      let sz = 0;
      while (offset < payload.length) {
        const val = payload[offset++];
        sz += val;
        if (val < 255) break;
      }
      frameSizes[i] = sz;
      totalKnownSize += sz;
    }
  } else if (lacing === 2) {
    // Fixed-size Lacing
    const remaining = payload.length - offset;
    const szPerFrame = Math.floor(remaining / numFrames);
    for (let i = 0; i < numFrames - 1; i++) {
      frameSizes[i] = szPerFrame;
      totalKnownSize += szPerFrame;
    }
  } else if (lacing === 3) {
    // EBML Lacing
    const firstSz = readDataSize(payload, offset);
    if (!firstSz || firstSz.value < 0) return null;
    offset += firstSz.length;
    frameSizes[0] = firstSz.value;
    totalKnownSize = firstSz.value;

    for (let i = 1; i < numFrames - 1; i++) {
      if (offset >= payload.length) return null;
      const fb = payload[offset];
      if (fb === 0) return null;

      let vLen = 1;
      let vMask = 0x80;
      while (vLen <= 8 && !(fb & vMask)) {
        vLen++;
        vMask >>= 1;
      }
      if (vLen > 8 || offset + vLen > payload.length) return null;

      let rawVal = fb & (vMask - 1);
      for (let j = 1; j < vLen; j++) {
        rawVal = rawVal * 256 + payload[offset + j];
      }
      offset += vLen;

      // Signed difference formula: rawVal - ((1 << (7 * vLen - 1)) - 1)
      const bias = Math.pow(2, 7 * vLen - 1) - 1;
      const signedDiff = rawVal - bias;

      const currentSz = frameSizes[i - 1] + signedDiff;
      if (currentSz < 0) return null;
      frameSizes[i] = currentSz;
      totalKnownSize += currentSz;
    }
  }

  // Last frame takes remaining bytes
  const lastSize = payload.length - offset - totalKnownSize;
  if (lastSize < 0) return null;
  frameSizes[numFrames - 1] = lastSize;

  const frames: Uint8Array[] = [];
  let dOff = offset;
  for (let i = 0; i < numFrames; i++) {
    const sz = frameSizes[i];
    if (dOff + sz > payload.length) return null;
    frames.push(payload.subarray(dOff, dOff + sz));
    dOff += sz;
  }

  return {
    trackNumber,
    relativeTime,
    isKeyframe,
    data: frames[0],
    frames,
  };
}

/**
 * Parses all media blocks and the cluster timestamp from a Matroska Cluster element payload.
 * Supports partial payload parsing and returns bytesConsumed.
 */
export function parseClusterPayload(
  clusterPayload: Uint8Array,
  initialClusterTimeMs = 0
): {
  clusterTimeMs: number;
  blocks: (ParsedBlock & { ptsMs: number })[];
  bytesConsumed: number;
} {
  let offset = 0;
  let clusterTimeMs = initialClusterTimeMs;
  const blocks: (ParsedBlock & { ptsMs: number })[] = [];

  while (offset < clusterPayload.length) {
    const el = readElementId(clusterPayload, offset);
    if (!el) break;
    if (el.value === EBML_ID.CLUSTER) {
      break;
    }
    const elOffset = offset + el.length;

    const sz = readDataSize(clusterPayload, elOffset);
    if (!sz) break;
    const dataOffset = elOffset + sz.length;

    if (sz.value < 0 || dataOffset + sz.value > clusterPayload.length) {
      // Incomplete element: stop here, bytesConsumed is up to the start of this element
      break;
    }

    if (el.value === EBML_ID.TIME_CODE) {
      clusterTimeMs = readUint(clusterPayload, dataOffset, sz.value);
    } else if (el.value === EBML_ID.SIMPLE_BLOCK) {
      const blockPayload = clusterPayload.subarray(dataOffset, dataOffset + sz.value);
      const parsed = parseSimpleBlock(blockPayload);
      if (parsed) {
        if (parsed.frames && parsed.frames.length > 1) {
          for (let f = 0; f < parsed.frames.length; f++) {
            blocks.push({
              trackNumber: parsed.trackNumber,
              relativeTime: parsed.relativeTime,
              isKeyframe: parsed.isKeyframe && f === 0,
              data: parsed.frames[f],
              ptsMs: clusterTimeMs + parsed.relativeTime + Math.round(f * 21.333),
            });
          }
        } else {
          blocks.push({
            ...parsed,
            ptsMs: clusterTimeMs + parsed.relativeTime,
          });
        }
      }
    } else if (el.value === EBML_ID.BLOCK_GROUP) {
      // Parse Block inside BlockGroup
      let bgOff = dataOffset;
      const bgEnd = dataOffset + sz.value;
      let parsedBlock: any = null;
      let blockDurationMs: number | undefined;

      while (bgOff < bgEnd) {
        const bgEl = readElementId(clusterPayload, bgOff);
        if (!bgEl) break;
        bgOff += bgEl.length;
        const bgSz = readDataSize(clusterPayload, bgOff);
        if (!bgSz) break;
        bgOff += bgSz.length;
        if (bgEl.value === EBML_ID.BLOCK) {
          const blockPayload = clusterPayload.subarray(bgOff, bgOff + bgSz.value);
          parsedBlock = parseSimpleBlock(blockPayload);
        } else if (bgEl.value === EBML_ID.BLOCK_DURATION) {
          blockDurationMs = readUint(clusterPayload, bgOff, bgSz.value);
        }
        bgOff += bgSz.value;
      }

      if (parsedBlock) {
        if (parsedBlock.frames && parsedBlock.frames.length > 1) {
          for (let f = 0; f < parsedBlock.frames.length; f++) {
            blocks.push({
              trackNumber: parsedBlock.trackNumber,
              relativeTime: parsedBlock.relativeTime,
              isKeyframe: parsedBlock.isKeyframe && f === 0,
              data: parsedBlock.frames[f],
              ptsMs: clusterTimeMs + parsedBlock.relativeTime + Math.round(f * 21.333),
              durationMs: blockDurationMs,
            });
          }
        } else {
          blocks.push({
            ...parsedBlock,
            ptsMs: clusterTimeMs + parsedBlock.relativeTime,
            durationMs: blockDurationMs,
          });
        }
      }
    }

    offset = dataOffset + sz.value;
  }

  return { clusterTimeMs, blocks, bytesConsumed: offset };
}

/**
 * Scans a byte buffer for the next Cluster element header (0x1F 0x43 0xB6 0x75)
 */
export function findNextCluster(data: Uint8Array, startOffset = 0): number {
  for (let i = startOffset; i <= data.length - 4; i++) {
    if (
      data[i] === 0x1f &&
      data[i + 1] === 0x43 &&
      data[i + 2] === 0xb6 &&
      data[i + 3] === 0x75
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Extracts and cleans text from Matroska subtitle blocks (UTF-8, ASS/SSA, WebVTT)
 */
export function cleanSubtitleText(codecId: string, data: Uint8Array): string {
  try {
    const raw = new TextDecoder('utf-8').decode(data);
    if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA') {
      // In ASS/SSA: Format is ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      let commaCount = 0;
      let textStart = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === ',') {
          commaCount++;
          if (commaCount === 8) {
            textStart = i + 1;
            break;
          }
        }
      }
      const text = commaCount >= 8 ? raw.slice(textStart) : raw;
      // Strip ASS tags like {\an8}, {\b1}, {\c&H...} and replace \N with newline
      return text.replace(/\{[^}]+\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').trim();
    }
    // S_TEXT/UTF8 or S_TEXT/WEBVTT: strip basic HTML tags (e.g. <i>, <b>)
    return raw.replace(/<[^>]+>/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * Resolves 2/3-letter ISO language codes or track name to human-readable language string
 */
export function getLanguageDisplayName(code?: string, name?: string): string {
  if (name && name.trim()) return name.trim();
  if (!code) return 'Subtitle';
  const c = code.toLowerCase().trim();
  const map: Record<string, string> = {
    eng: 'English',
    en: 'English',
    spa: 'Spanish',
    es: 'Spanish',
    fre: 'French',
    fra: 'French',
    fr: 'French',
    ger: 'German',
    deu: 'German',
    de: 'German',
    ita: 'Italian',
    it: 'Italian',
    por: 'Portuguese',
    pt: 'Portuguese',
    rus: 'Russian',
    ru: 'Russian',
    hin: 'Hindi',
    hi: 'Hindi',
    tam: 'Tamil',
    ta: 'Tamil',
    tel: 'Telugu',
    te: 'Telugu',
    mal: 'Malayalam',
    ml: 'Malayalam',
    kan: 'Kannada',
    kn: 'Kannada',
    zho: 'Chinese',
    chi: 'Chinese',
    zh: 'Chinese',
    jpn: 'Japanese',
    ja: 'Japanese',
    kor: 'Korean',
    ko: 'Korean',
    ara: 'Arabic',
    ar: 'Arabic',
    und: 'Subtitle',
  };
  return map[c] || c.toUpperCase();
}
