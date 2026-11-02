/**
 * Pure TypeScript Matroska -> fMP4 Transmuxer
 * Converts Matroska Clusters & SimpleBlocks into fragmented MP4 segments for MSE.
 */

import {
  generateInitSegment,
  generateMediaSegment,
  generateAudioInitSegment,
  generateAudioMediaSegment,
  type VideoTrackConfig,
  type VideoSample,
  type AudioTrackConfig,
  type AudioSample,
} from './mp4Generator.ts';
import {
  parseClusterPayload,
  annexBToAvcc,
  splitAnnexBNals,
  type MatroskaMetadata,
  type VideoTrack,
  type AudioTrack,
  type ParsedBlock,
} from './ebml.ts';

export interface TransmuxResult {
  initSegment?: Uint8Array;
  mediaSegment?: Uint8Array;
  audioInitSegment?: Uint8Array;
  audioMediaSegment?: Uint8Array;
  samplesCount: number;
  startPtsMs: number;
  endPtsMs: number;
}

export class MatroskaTransmuxer {
  private metadata: MatroskaMetadata;
  private videoTrack: VideoTrack | null = null;
  private audioTrack: AudioTrack | null = null;
  private codecType: 'avc' | 'hevc' = 'avc';

  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private initSegmentGenerated = false;
  private audioInitSegmentGenerated = false;
  private waitingForKeyframe = false;
  private sequenceNumber = 1;
  private audioSequenceNumber = 1;
  private defaultSampleDurationMs = 40; // 25fps fallback default

  constructor(metadata: MatroskaMetadata) {
    this.metadata = metadata;

    // Pick first video track
    const vTrack = metadata.videoTracks[0];

    if (vTrack) {
      this.videoTrack = vTrack;
      const cid = (vTrack.codecId || '').toUpperCase();
      const isHevc = cid.includes('HEVC') || cid.includes('H265') || cid.includes('V_MPEGH');
      this.codecType = isHevc ? 'hevc' : 'avc';

      if (vTrack.sps) this.sps = vTrack.sps;
      if (vTrack.pps) this.pps = vTrack.pps;
      if (vTrack.defaultDuration) {
        // defaultDuration is in nanoseconds
        this.defaultSampleDurationMs = Math.round(vTrack.defaultDuration / 1_000_000);
      }
    }

    if (metadata.audioTracks.length > 0) {
      // Prefer supported audio track (e.g. AAC) if present among multiple tracks
      const supportedTrack = metadata.audioTracks.find((t) => t.codecId === 'A_AAC');
      this.audioTrack = supportedTrack || metadata.audioTracks[0];
    }
  }

  public hasInitSegment(): boolean {
    return this.initSegmentGenerated;
  }

  public getVideoCodecString(): string {
    if (this.codecType === 'hevc') {
      if (this.videoTrack?.codecPrivate && this.videoTrack.codecPrivate.length >= 13) {
        const cp = this.videoTrack.codecPrivate;
        const profileIdc = cp[1] & 0x1f;
        const tier = (cp[1] & 0x20) ? 'H' : 'L';
        const levelIdc = cp[12];
        const flags = ((cp[2] << 24) | (cp[3] << 16) | (cp[4] << 8) | cp[5]) >>> 0;
        const flagsHex = flags.toString(16).toUpperCase();
        return `video/mp4; codecs="hvc1.${profileIdc}.${flagsHex}.${tier}${levelIdc}.B0"`;
      }
      return 'video/mp4; codecs="hvc1.1.6.L93.B0"';
    }

    if (this.sps && this.sps.length >= 4) {
      const profile = this.sps[1].toString(16).padStart(2, '0');
      const compat = this.sps[2].toString(16).padStart(2, '0');
      const level = this.sps[3].toString(16).padStart(2, '0');
      return `video/mp4; codecs="avc1.${profile}${compat}${level}"`;
    }
    // High Profile Level 4.1 default
    return 'video/mp4; codecs="avc1.640029"';
  }

  public getAudioCodecString(): string | null {
    if (!this.audioTrack) return null;
    const cid = this.audioTrack.codecId;
    if (cid === 'A_AAC') {
      return 'audio/mp4; codecs="mp4a.40.2"';
    }
    // AC3, EAC3, DTS, TrueHD cannot be remuxed by mp4Generator
    return null;
  }

  public isAudioSupported(): boolean {
    if (!this.audioTrack) return false;
    const cid = this.audioTrack.codecId;
    // mp4Generator only supports AAC (mp4a with AudioSpecificConfig)
    return cid === 'A_AAC';
  }

  public getAudioCodecName(): string {
    if (!this.audioTrack) return 'None';
    return this.audioTrack.codecId.replace(/^A_/, '');
  }

  /**
   * Generates or returns the fMP4 init segment
   */
  public generateInitSegment(): Uint8Array | null {
    if (!this.videoTrack) {
      return null;
    }

    if (this.codecType === 'hevc') {
      if (!this.videoTrack.codecPrivate || this.videoTrack.codecPrivate.length === 0) {
        return null;
      }
      const videoConfig: VideoTrackConfig = {
        trackId: 1,
        timescale: 1000,
        width: this.videoTrack.width || 1920,
        height: this.videoTrack.height || 1080,
        codecType: 'hevc',
        codecPrivate: this.videoTrack.codecPrivate,
      };
      const init = generateInitSegment(videoConfig);
      this.initSegmentGenerated = true;
      return init;
    }

    if (!this.sps || !this.pps) {
      return null;
    }

    const videoConfig: VideoTrackConfig = {
      trackId: 1,
      timescale: 1000, // 1 tick = 1 ms
      width: this.videoTrack.width || 1920,
      height: this.videoTrack.height || 1080,
      codecType: 'avc',
      sps: this.sps,
      pps: this.pps,
    };

    const init = generateInitSegment(videoConfig);
    this.initSegmentGenerated = true;
    return init;
  }

  /**
   * Inspects a video frame to extract SPS and PPS if not already known
   */
  private extractSpsPpsFromFrame(frameData: Uint8Array): void {
    if (this.sps && this.pps) return;

    // Check Annex B
    const nals = splitAnnexBNals(frameData);
    if (nals.length > 0) {
      for (const nal of nals) {
        const nalType = nal[0] & 0x1f;
        if (nalType === 7 && !this.sps) {
          this.sps = nal;
        } else if (nalType === 8 && !this.pps) {
          this.pps = nal;
        }
      }
      return;
    }

    // Check AVCC (4-byte length prefixes)
    let offset = 0;
    while (offset + 4 < frameData.length) {
      const len =
        (frameData[offset] << 24) |
        (frameData[offset + 1] << 16) |
        (frameData[offset + 2] << 8) |
        frameData[offset + 3];
      offset += 4;
      if (len <= 0 || offset + len > frameData.length) break;

      const nalType = frameData[offset] & 0x1f;
      if (nalType === 7 && !this.sps) {
        this.sps = frameData.slice(offset, offset + len);
      } else if (nalType === 8 && !this.pps) {
        this.pps = frameData.slice(offset, offset + len);
      }
      offset += len;
    }
  }

  public getVideoTrackNumber(): number {
    return this.videoTrack?.trackNumber || 1;
  }

  public getAudioTrackNumber(): number | undefined {
    return this.audioTrack?.trackNumber;
  }

  /**
   * Transmuxes a Matroska Cluster element payload into an fMP4 media segment.
   */
  public transmuxCluster(clusterPayload: Uint8Array): TransmuxResult | null {
    if (!this.videoTrack) return null;

    const { blocks } = parseClusterPayload(clusterPayload);
    return this.transmuxBlocks(blocks);
  }

  /**
   * Transmuxes parsed Matroska blocks into an fMP4 media segment.
   * Enables fine-grained streaming of sub-cluster blocks without waiting for full cluster download.
   */
  public transmuxBlocks(blocks: (ParsedBlock & { ptsMs: number })[]): TransmuxResult | null {
    if (!this.videoTrack || blocks.length === 0) return null;

    // Filter to video track blocks
    let videoBlocks = blocks.filter((b) => b.trackNumber === this.videoTrack!.trackNumber);
    if (videoBlocks.length === 0) return null;

    if (this.waitingForKeyframe) {
      const firstKeyIdx = videoBlocks.findIndex((b) => b.isKeyframe);
      if (firstKeyIdx === -1) {
        // Discard blocks with no keyframe after seek
        return null;
      }
      videoBlocks = videoBlocks.slice(firstKeyIdx);
      this.waitingForKeyframe = false;
    }

    let initSegment: Uint8Array | undefined;

    // If init segment is not ready, generate for HEVC or extract SPS/PPS for AVC
    if (!this.initSegmentGenerated) {
      if (this.codecType === 'hevc' && this.videoTrack.codecPrivate) {
        initSegment = this.generateInitSegment() || undefined;
      } else {
        for (const block of videoBlocks) {
          if (block.isKeyframe) {
            this.extractSpsPpsFromFrame(block.data);
            if (this.sps && this.pps) {
              initSegment = this.generateInitSegment() || undefined;
              break;
            }
          }
        }
      }
      if (!this.initSegmentGenerated) {
        // Still waiting for parameter sets
        return null;
      }
    }

    // Convert blocks to VideoSamples
    const samples: VideoSample[] = [];
    const basePts = videoBlocks[0].ptsMs;

    for (let i = 0; i < videoBlocks.length; i++) {
      const current = videoBlocks[i];
      const next = videoBlocks[i + 1];

      let duration = next
        ? Math.max(1, next.ptsMs - current.ptsMs)
        : this.defaultSampleDurationMs;

      // Sanity cap sample duration to 500ms to prevent buffer drift
      if (duration > 500) {
        duration = this.defaultSampleDurationMs;
      }

      const avccData = annexBToAvcc(current.data);

      samples.push({
        data: avccData,
        duration,
        dts: current.ptsMs,
        pts: current.ptsMs,
        isKeyframe: current.isKeyframe,
      });
    }

    const mediaSegment = generateMediaSegment(
      this.sequenceNumber++,
      basePts,
      1, // trackId 1
      samples
    );

    const startPtsMs = samples[0].pts;
    const lastSample = samples[samples.length - 1];
    const endPtsMs = lastSample.pts + lastSample.duration;

    // Transmux Audio Blocks (if audio track is AAC or MP3)
    let audioInitSegment: Uint8Array | undefined;
    let audioMediaSegment: Uint8Array | undefined;

    if (this.audioTrack && this.isAudioSupported()) {
      if (!this.audioInitSegmentGenerated) {
        const audioConfig: AudioTrackConfig = {
          trackId: 2,
          timescale: 1000,
          channelCount: this.audioTrack.channels || 2,
          sampleRate: Math.round(this.audioTrack.samplingFrequency || 48000),
          audioSpecificConfig: this.audioTrack.codecPrivate,
        };
        audioInitSegment = generateAudioInitSegment(audioConfig);
        this.audioInitSegmentGenerated = true;
      }

      const audioBlocks = blocks.filter((b) => b.trackNumber === this.audioTrack!.trackNumber);
      if (audioBlocks.length > 0) {
        const audioSamples: AudioSample[] = [];
        const sampleRate = Math.round(this.audioTrack.samplingFrequency || 48000);
        const standardFrameDur = Math.round((1024 / sampleRate) * 1000);

        for (let i = 0; i < audioBlocks.length; i++) {
          const cur = audioBlocks[i];
          const next = audioBlocks[i + 1];
          let dur = next ? Math.max(1, next.ptsMs - cur.ptsMs) : standardFrameDur;
          if (dur > 200) dur = standardFrameDur;

          audioSamples.push({
            data: cur.data,
            duration: dur,
            pts: cur.ptsMs,
          });
        }

        const baseAudioPts = audioBlocks[0].ptsMs;
        audioMediaSegment = generateAudioMediaSegment(
          this.audioSequenceNumber++,
          baseAudioPts,
          2, // trackId 2
          audioSamples
        );
      }
    }

    return {
      initSegment,
      mediaSegment,
      audioInitSegment,
      audioMediaSegment,
      samplesCount: samples.length,
      startPtsMs,
      endPtsMs,
    };
  }

  public resetSequence(newBasePtsMs = 0): void {
    // When seeking to a new timeline point, reset sequence numbers
    this.sequenceNumber = 1;
    this.audioSequenceNumber = 1;
    this.waitingForKeyframe = true;
  }
}
