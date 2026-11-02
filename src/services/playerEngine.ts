/**
 * PlayerEngine: Dual-Path Playback Coordinator & Web Audio API Night Mode
 * Handles Direct HTTP 206 Native Stream (Path A) vs. MSE Demux/Remux (Path B).
 */

import { MSEController } from './mseController';
import { tgStreamEngine } from './tgStreamEngine';

export interface PlayerEngineOptions {
  videoElement: HTMLVideoElement;
  streamId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  initialTime?: number;
  onReady?: (durationSec: number) => void;
  onStatus?: (status: string) => void;
  onError?: (error: string) => void;
  onAudioNotice?: (notice: string) => void;
}

export class PlayerEngine {
  private video: HTMLVideoElement;
  private options: PlayerEngineOptions;
  private mseController: MSEController | null = null;
  private activePath: 'native' | 'mse' = 'native';
  private hasTriedMse = false;
  private hasTriedNative = false;
  private isMkvOrTs = false;

  // Web Audio API Night Mode nodes
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private isNightModeEnabled = false;

  private silentAudioTimer: any = null;
  private nativeLoadedMetadataListener: (() => void) | null = null;
  private nativeErrorListener: (() => void) | null = null;
  private isDestroyed = false;

  constructor(options: PlayerEngineOptions) {
    this.video = options.videoElement;
    this.options = options;
  }

  public async start(): Promise<void> {
    const { fileName, mimeType } = this.options;
    const lowerName = (fileName || '').toLowerCase();
    this.isMkvOrTs =
      lowerName.endsWith('.mkv') ||
      lowerName.endsWith('.avi') ||
      lowerName.endsWith('.ts') ||
      mimeType === 'video/x-matroska' ||
      mimeType === 'video/mkv';

    // Auto-select path: MKV/TS files go to MSE remuxer; MP4/WebM go to native stream
    if (this.isMkvOrTs) {
      this.hasTriedMse = true;
      this.startMsePath();
    } else {
      this.hasTriedNative = true;
      this.startNativePath();
    }
  }

  private startNativePath(): void {
    this.destroyNative();
    this.activePath = 'native';
    this.hasTriedNative = true;
    this.options.onStatus?.('Streaming via HTTP 206 range proxy...');

    const nativeUrl = `/tg-stream/${encodeURIComponent(this.options.streamId)}`;
    this.video.src = nativeUrl;
    this.video.load();

    this.nativeLoadedMetadataListener = () => {
      if (this.isDestroyed || this.activePath !== 'native') return;
      if (this.video.duration > 0) {
        this.options.onReady?.(this.video.duration);
      }
    };

    this.nativeErrorListener = () => {
      if (this.isDestroyed || this.activePath !== 'native') return;
      const mediaErr = this.video.error;
      console.warn('Native video error:', mediaErr?.code, mediaErr?.message);
      if (!this.hasTriedMse) {
        this.hasTriedMse = true;
        this.startMsePath();
      } else {
        this.options.onError?.(
          mediaErr?.message || 'Video container or codec could not be decoded.'
        );
      }
    };

    this.video.addEventListener('loadedmetadata', this.nativeLoadedMetadataListener, { once: true });
    this.video.addEventListener('error', this.nativeErrorListener, { once: true });

    if (this.options.initialTime && this.options.initialTime > 0) {
      this.video.currentTime = this.options.initialTime;
    }

    this.video.play().catch(() => {});

    // Silent Audio & Error Detector (switches to MSE path if unsupported)
    this.setupSilentAudioDetector();
  }

  private startMsePath(): void {
    this.destroyNative();
    this.activePath = 'mse';
    this.options.onStatus?.('Transmuxing Matroska stream for MSE hardware decoding...');

    const parts = this.options.streamId.split('_');
    const chatId = parts[0];
    const messageId = parts[1] || '0';

    this.mseController = new MSEController(this.video, {
      onReady: (dur) => {
        if (this.isDestroyed) return;
        this.options.onReady?.(dur);
        if (this.options.initialTime && this.options.initialTime > 0) {
          this.mseController?.seek(this.options.initialTime);
        }
        this.video.play().catch(() => {});
      },
      onStatus: (status) => {
        if (!this.isDestroyed) this.options.onStatus?.(status);
      },
      onAudioUnsupported: (codec) => {
        if (!this.isDestroyed) {
          this.options.onAudioNotice?.(`Audio track (${codec}) requires multichannel hardware decoder.`);
        }
      },
      onError: (err) => {
        if (this.isDestroyed) return;
        // Never fall back to native for MKV/TS because browsers do not support native MKV demuxing!
        if (this.activePath === 'mse' && !this.hasTriedNative && !this.isMkvOrTs) {
          this.hasTriedNative = true;
          console.warn('MSE pipeline error, falling back to Native HTTP 206 stream:', err);
          this.startNativePath();
        } else {
          this.options.onError?.(err);
        }
      },
    });

    this.mseController.start(chatId, messageId, this.options.fileSize, this.options.mimeType);
  }

  private setupSilentAudioDetector(): void {
    if (this.silentAudioTimer) clearTimeout(this.silentAudioTimer);

    // After 2.5s of playback, inspect if audio is decoded
    this.silentAudioTimer = setTimeout(() => {
      if (this.isDestroyed || this.activePath !== 'native') return;

      const v = this.video as any;
      const hasAudioTrack =
        v.audioTracks?.length > 0 ||
        v.mozHasAudio !== false ||
        (v.webkitAudioDecodedByteCount !== undefined && v.webkitAudioDecodedByteCount > 0);

      // If video is playing with dimensions but audio decoded bytes is 0 in multi-channel video:
      if (v.videoWidth > 0 && v.webkitAudioDecodedByteCount === 0 && !v.muted) {
        console.warn('Detected silent/unsupported audio track in Native stream, switching to MSE pipeline...');
        this.startMsePath();
      }
    }, 2500);
  }

  public seek(timeSec: number): void {
    tgStreamEngine.recenterRingBuffer(this.options.streamId, timeSec, this.video.duration || 0);
    if (this.activePath === 'mse' && this.mseController) {
      this.mseController.seek(timeSec);
    } else {
      this.video.currentTime = timeSec;
    }
  }

  /**
   * Periodic playback progress hook:
   * Prunes chunks outside [currentTime - 30s, currentTime + 30s] to enforce 1-minute rolling window.
   */
  public onPlaybackProgress(timeSec: number): void {
    tgStreamEngine.pruneCacheWindow(timeSec, this.video.duration || 0);
  }

  /**
   * Web Audio API DynamicsCompressorNode Night Mode:
   * threshold: -36dB, knee: 30, ratio: 12, attack: 0.003, release: 0.25, gain: 1.6x
   */
  public toggleNightMode(enabled: boolean): boolean {
    this.isNightModeEnabled = enabled;

    try {
      if (!this.audioCtx) {
        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtxClass) return false;
        this.audioCtx = new AudioCtxClass();
        this.sourceNode = this.audioCtx.createMediaElementSource(this.video);
        this.compressorNode = this.audioCtx.createDynamicsCompressor();
        this.gainNode = this.audioCtx.createGain();

        // Configure Night Mode compression parameters
        this.compressorNode.threshold.setValueAtTime(-36, this.audioCtx.currentTime);
        this.compressorNode.knee.setValueAtTime(30, this.audioCtx.currentTime);
        this.compressorNode.ratio.setValueAtTime(12, this.audioCtx.currentTime);
        this.compressorNode.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
        this.compressorNode.release.setValueAtTime(0.25, this.audioCtx.currentTime);
        this.gainNode.gain.setValueAtTime(1.6, this.audioCtx.currentTime);
      }

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      if (this.sourceNode && this.compressorNode && this.gainNode) {
        this.sourceNode.disconnect();
        if (enabled) {
          // Route: Video -> Compressor -> Makeup Gain -> Speaker
          this.sourceNode.connect(this.compressorNode);
          this.compressorNode.connect(this.gainNode);
          this.gainNode.connect(this.audioCtx.destination);
        } else {
          // Route: Video -> Speaker (Standard)
          this.sourceNode.connect(this.audioCtx.destination);
        }
      }
      return this.isNightModeEnabled;
    } catch (e) {
      console.warn('Web Audio API Night Mode setup error:', e);
      return false;
    }
  }

  private destroyNative(): void {
    if (this.nativeLoadedMetadataListener) {
      this.video.removeEventListener('loadedmetadata', this.nativeLoadedMetadataListener);
      this.nativeLoadedMetadataListener = null;
    }
    if (this.nativeErrorListener) {
      this.video.removeEventListener('error', this.nativeErrorListener);
      this.nativeErrorListener = null;
    }
    if (this.silentAudioTimer) {
      clearTimeout(this.silentAudioTimer);
      this.silentAudioTimer = null;
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.destroyNative();

    if (this.mseController) {
      this.mseController.destroy();
      this.mseController = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
  }
}
