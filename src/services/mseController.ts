/**
 * MSE (Media Source Extensions) Stream Controller
 * Coordinates the HTMLVideoElement, MediaSource, SourceBuffer,
 * Web Worker demuxing/transmuxing pipeline, sliding window buffer eviction,
 * and byte-range seeking.
 */

import { tgStreamEngine } from './tgStreamEngine';

export interface MSEControllerEvents {
  onReady?: (durationSec: number) => void;
  onError?: (error: string) => void;
  onStatus?: (status: string) => void;
  onAudioUnsupported?: (codecName: string) => void;
  onWaiting?: () => void;
  onPlaying?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
}

export class MSEController {
  private video: HTMLVideoElement;
  private worker: Worker | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private audioSourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private events: MSEControllerEvents;

  private segmentQueue: ArrayBuffer[] = [];
  private audioQueue: ArrayBuffer[] = [];
  private isSourceOpen = false;
  private hasInitSegment = false;
  private isEvicting = false;
  private evictionInterval: any = null;
  private durationSec = 0;
  private isSeeking = false;
  private pendingSeekTarget: number | null = null;
  private pendingVideoCodec: string | null = null;
  private pendingAudioCodec: string | null = null;
  private lastSentPlayheadTime = -1;
  private videoPlayheadListener: (() => void) | null = null;

  constructor(video: HTMLVideoElement, events: MSEControllerEvents = {}) {
    this.video = video;
    this.events = events;
  }

  public async start(
    channelId: string,
    messageId: string | number,
    fileSize: number,
    mimeType = 'video/x-matroska'
  ): Promise<void> {
    this.destroy();

    // Check MSE browser support
    if (typeof window === 'undefined' || !('MediaSource' in window)) {
      this.events.onError?.('MediaSource Extensions (MSE) is not supported in this browser.');
      return;
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;

    this.mediaSource.addEventListener('sourceopen', () => {
      this.isSourceOpen = true;
      if (this.durationSec > 0 && this.mediaSource && this.mediaSource.readyState === 'open') {
        try {
          this.mediaSource.duration = this.durationSec;
        } catch (e) {}
      }
      if (this.pendingAudioCodec) {
        const ac = this.pendingAudioCodec;
        this.pendingAudioCodec = null;
        this.initAudioSourceBuffer(ac);
      }
      if (this.pendingVideoCodec) {
        const vc = this.pendingVideoCodec;
        this.pendingVideoCodec = null;
        this.initSourceBuffer(vc);
      }
      this.flushQueue();
      this.flushAudioQueue();
    });

    this.mediaSource.addEventListener('sourceended', () => {
      this.isSourceOpen = false;
    });

    this.mediaSource.addEventListener('sourceclose', () => {
      this.isSourceOpen = false;
    });

    // Start Web Worker
    try {
      this.worker = new Worker(
        new URL('../workers/streamWorker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (e: any) {
      this.events.onError?.(`Failed to instantiate stream worker: ${e.message}`);
      return;
    }

    this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);

    this.worker.postMessage({
      type: 'START',
      channelId,
      messageId,
      fileSize,
      mimeType,
    });

    // Bind playhead tracking to feed 1-minute matrix boundary to worker
    this.videoPlayheadListener = () => {
      this.sendPlayheadUpdate();
    };
    this.video.addEventListener('timeupdate', this.videoPlayheadListener);
    this.video.addEventListener('pause', this.videoPlayheadListener);
    this.video.addEventListener('play', this.videoPlayheadListener);

    // Setup proactive sliding window buffer eviction every 8 seconds
    this.startEvictionLoop();
  }

  private sendPlayheadUpdate(): void {
    if (!this.worker) return;
    const now = this.video.currentTime;
    if (Math.abs(now - this.lastSentPlayheadTime) >= 0.5 || this.video.paused) {
      this.lastSentPlayheadTime = now;
      this.worker.postMessage({
        type: 'PLAYHEAD_UPDATE',
        currentTimeSec: now,
        isPaused: this.video.paused,
      });
    }
  }

  public isLocallyBuffered(timeSec: number): boolean {
    const b = this.video.buffered;
    if (!b || b.length === 0) return false;
    for (let i = 0; i < b.length; i++) {
      if (timeSec >= b.start(i) && timeSec <= b.end(i) - 0.5) {
        return true;
      }
    }
    return false;
  }

  private handleWorkerMessage(msg: any): void {
    if (!msg) return;

    switch (msg.type) {
      case 'STATUS':
        this.events.onStatus?.(msg.status);
        break;

      case 'METADATA_LOADED': {
        const { videoCodec, durationSec, isAudioSupported, audioCodecName } = msg;
        this.durationSec = durationSec || 0;

        if (this.durationSec > 0 && this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.duration = this.durationSec;
          } catch (e) {
            // ignore duration write error on live streams
          }
        }

        if (isAudioSupported) {
          this.initAudioSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
        } else if (audioCodecName && audioCodecName !== 'None') {
          if (MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"')) {
            this.initAudioSourceBuffer('audio/mp4; codecs="ac-3"');
          } else {
            this.events.onAudioUnsupported?.(audioCodecName);
          }
        }

        // Initialize Video SourceBuffer if not yet created
        this.initSourceBuffer(videoCodec);
        this.events.onReady?.(this.durationSec);
        break;
      }

      case 'INIT_SEGMENT': {
        this.hasInitSegment = true;
        this.enqueueSegment(msg.buffer, true);
        break;
      }

      case 'AUDIO_INIT_SEGMENT': {
        this.enqueueAudioSegment(msg.buffer, true);
        break;
      }

      case 'MEDIA_SEGMENT': {
        this.enqueueSegment(msg.buffer, false);
        break;
      }

      case 'AUDIO_MEDIA_SEGMENT': {
        this.enqueueAudioSegment(msg.buffer, false);
        break;
      }

      case 'SEEK_READY': {
        this.isSeeking = false;
        this.events.onStatus?.('');
        if (msg.actualTimeSec !== undefined) {
          try {
            this.video.currentTime = msg.actualTimeSec;
          } catch (e) {}
        }
        if (this.pendingSeekTarget !== null) {
          const target = this.pendingSeekTarget;
          this.pendingSeekTarget = null;
          this.seek(target);
          return;
        }
        break;
      }

      case 'DELEGATE_REQUEST_CHUNK': {
        const { requestId, streamId, chunkIndex } = msg;
        tgStreamEngine.getChunk(streamId, chunkIndex)
          .then((chunk) => {
            this.worker?.postMessage({
              type: 'CHUNK_RESPONSE',
              requestId,
              data: chunk,
            });
          })
          .catch((err) => {
            this.worker?.postMessage({
              type: 'CHUNK_RESPONSE',
              requestId,
              error: err.message || 'Chunk request failed',
            });
          });
        break;
      }

      case 'ERROR': {
        this.events.onError?.(msg.message);
        break;
      }

      case 'EOF': {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch (e) {
            // ignore
          }
        }
        break;
      }
    }
  }

  private initSourceBuffer(mimeCodec: string): void {
    if (!this.mediaSource || this.sourceBuffer) return;
    if (this.mediaSource.readyState !== 'open') {
      this.pendingVideoCodec = mimeCodec;
      return;
    }

    // Check codec compatibility
    let candidateCodec = mimeCodec;
    if (!MediaSource.isTypeSupported(candidateCodec)) {
      if (candidateCodec.includes('hvc1') || candidateCodec.includes('hev1')) {
        const hevcAlternatives = [
          'video/mp4; codecs="hvc1.1.6.L93.B0"',
          'video/mp4; codecs="hev1.1.6.L93.B0"',
          'video/mp4; codecs="hvc1.1.6.L120.B0"',
          'video/mp4; codecs="hev1.1.6.L120.B0"',
          'video/mp4; codecs="hvc1"',
          'video/mp4; codecs="hev1"',
        ];
        const match = hevcAlternatives.find((a) => MediaSource.isTypeSupported(a));
        if (match) {
          candidateCodec = match;
        }
      } else if (candidateCodec.includes('avc1')) {
        const avcAlternatives = [
          'video/mp4; codecs="avc1.640029"',
          'video/mp4; codecs="avc1.4d401f"',
          'video/mp4; codecs="avc1.42e01e"',
        ];
        const match = avcAlternatives.find((a) => MediaSource.isTypeSupported(a));
        if (match) {
          candidateCodec = match;
        }
      }
    }

    if (!MediaSource.isTypeSupported(candidateCodec)) {
      this.events.onError?.(`MediaSource does not support codec ${mimeCodec}`);
      return;
    }

    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(candidateCodec);
      try {
        this.sourceBuffer.mode = 'segments';
      } catch (modeErr) {
        // default mode preserved
      }

      this.sourceBuffer.addEventListener('updateend', () => {
        this.flushQueue();
      });

      this.sourceBuffer.addEventListener('error', (e) => {
        console.error('SourceBuffer error:', e);
        this.events.onError?.('SourceBuffer decoding error encountered.');
      });
    } catch (e: any) {
      console.error('Failed to create SourceBuffer:', e);
      this.events.onError?.(`MediaSource does not support codec ${mimeCodec}`);
    }
  }

  private initAudioSourceBuffer(audioCodec = 'audio/mp4; codecs="mp4a.40.2"'): void {
    if (!this.mediaSource || this.audioSourceBuffer) return;
    if (this.mediaSource.readyState !== 'open') {
      this.pendingAudioCodec = audioCodec;
      return;
    }
    if (!MediaSource.isTypeSupported(audioCodec)) {
      console.warn('Audio codec not supported by browser MediaSource:', audioCodec);
      return;
    }

    try {
      this.audioSourceBuffer = this.mediaSource.addSourceBuffer(audioCodec);
      try {
        this.audioSourceBuffer.mode = 'segments';
      } catch (e) {}

      this.audioSourceBuffer.addEventListener('updateend', () => {
        this.flushAudioQueue();
      });

      this.audioSourceBuffer.addEventListener('error', (e) => {
        console.warn('Audio SourceBuffer error:', e);
      });
    } catch (e) {
      console.warn('Failed to add audio SourceBuffer:', e);
    }
  }

  private enqueueAudioSegment(buf: ArrayBuffer, isPriority = false): void {
    if (isPriority) {
      this.audioQueue.unshift(buf);
    } else {
      this.audioQueue.push(buf);
    }
    this.flushAudioQueue();
  }

  private flushAudioQueue(): void {
    if (!this.audioSourceBuffer || !this.isSourceOpen) return;
    if (this.audioSourceBuffer.updating || this.audioQueue.length === 0) return;

    const nextSegment = this.audioQueue.shift();
    if (nextSegment) {
      try {
        this.audioSourceBuffer.appendBuffer(nextSegment);
      } catch (err: any) {
        if (err.name === 'QuotaExceededError') {
          this.audioQueue.unshift(nextSegment);
        } else {
          console.warn('Failed to append audio buffer:', err);
        }
      }
    }
  }

  private enqueueSegment(buf: ArrayBuffer, isPriority = false): void {
    if (isPriority) {
      this.segmentQueue.unshift(buf);
    } else {
      this.segmentQueue.push(buf);
    }
    this.flushQueue();
  }

  private flushQueue(): void {
    if (!this.sourceBuffer || !this.isSourceOpen) return;
    if (this.sourceBuffer.updating || this.segmentQueue.length === 0) return;

    const nextSegment = this.segmentQueue.shift();
    if (nextSegment) {
      try {
        this.sourceBuffer.appendBuffer(nextSegment);
      } catch (err: any) {
        if (err.name === 'QuotaExceededError') {
          console.warn('QuotaExceededError: aggressively evicting older buffer segments...');
          this.evictBuffer(true);
          // Re-queue segment to retry after eviction
          this.segmentQueue.unshift(nextSegment);
        } else {
          console.error('Failed to appendBuffer:', err);
        }
      }
    }
  }

  /**
   * Fast byte-range seeking to timestamp
   */
  public seek(targetTimeSec: number): void {
    if (this.isSeeking) {
      this.pendingSeekTarget = targetTimeSec;
      return;
    }

    // Fast-path: If target is already within locally buffered 1-minute matrix, jump immediately without worker abort!
    if (this.isLocallyBuffered(targetTimeSec)) {
      try {
        this.video.currentTime = targetTimeSec;
        this.sendPlayheadUpdate();
        this.events.onStatus?.('');
      } catch (e) {}
      return;
    }

    this.isSeeking = true;
    this.segmentQueue = [];
    this.audioQueue = [];

    // Abort active SourceBuffer updates if any
    if (this.sourceBuffer && this.sourceBuffer.updating) {
      try {
        this.sourceBuffer.abort();
      } catch (e) {
        // ignore
      }
    }
    if (this.audioSourceBuffer && this.audioSourceBuffer.updating) {
      try {
        this.audioSourceBuffer.abort();
      } catch (e) {
        // ignore
      }
    }

    // Retarget worker
    this.worker?.postMessage({
      type: 'SEEK',
      targetTimeSec,
    });

    // Update video element time
    try {
      this.video.currentTime = targetTimeSec;
    } catch (e) {
      // ignore
    }
  }

  public pause(): void {
    this.worker?.postMessage({ type: 'PAUSE' });
    this.video.pause();
  }

  public resume(): void {
    this.worker?.postMessage({ type: 'RESUME' });
    this.video.play().catch(() => {});
  }

  /**
   * Proactive sliding window buffer eviction:
   * Keeps buffer memory < 80MB by removing already-played content older than 30 seconds.
   */
  private startEvictionLoop(): void {
    this.stopEvictionLoop();
    this.evictionInterval = setInterval(() => {
      this.evictBuffer(false);
    }, 8000);
  }

  private stopEvictionLoop(): void {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }
  }

  private evictBuffer(forceAggressive = false): void {
    if (
      !this.sourceBuffer ||
      this.sourceBuffer.updating ||
      this.isEvicting ||
      !this.isSourceOpen
    ) {
      return;
    }

    const currentPos = this.video.currentTime;
    const retainBehindSec = forceAggressive ? 10 : 30;

    if (currentPos > retainBehindSec) {
      const removeEnd = currentPos - retainBehindSec;
      try {
        this.isEvicting = true;
        this.sourceBuffer.remove(0, removeEnd);
        const onEvictEnd = () => {
          this.isEvicting = false;
          this.sourceBuffer?.removeEventListener('updateend', onEvictEnd);
          this.flushQueue();
        };
        this.sourceBuffer.addEventListener('updateend', onEvictEnd, { once: true });
      } catch (e) {
        this.isEvicting = false;
      }
    }
  }

  public destroy(): void {
    if (this.videoPlayheadListener) {
      this.video.removeEventListener('timeupdate', this.videoPlayheadListener);
      this.video.removeEventListener('pause', this.videoPlayheadListener);
      this.video.removeEventListener('play', this.videoPlayheadListener);
      this.videoPlayheadListener = null;
    }

    this.stopEvictionLoop();
    this.segmentQueue = [];
    this.audioQueue = [];
    this.isSeeking = false;
    this.pendingSeekTarget = null;
    this.pendingVideoCodec = null;
    this.pendingAudioCodec = null;

    if (this.worker) {
      this.worker.postMessage({ type: 'STOP' });
      this.worker.terminate();
      this.worker = null;
    }

    if (this.sourceBuffer) {
      try {
        if (this.sourceBuffer.updating) {
          this.sourceBuffer.abort();
        }
      } catch (e) {
        // ignore
      }
      this.sourceBuffer = null;
    }

    if (this.audioSourceBuffer) {
      try {
        if (this.audioSourceBuffer.updating) {
          this.audioSourceBuffer.abort();
        }
      } catch (e) {
        // ignore
      }
      this.audioSourceBuffer = null;
    }

    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch (e) {
        // ignore
      }
      this.mediaSource = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.isSourceOpen = false;
    this.hasInitSegment = false;
  }
}

