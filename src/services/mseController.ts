/**
 * MSE (Media Source Extensions) Stream Controller
 * Coordinates the HTMLVideoElement, MediaSource, SourceBuffer,
 * Web Worker demuxing/transmuxing pipeline, sliding window buffer eviction,
 * and byte-range seeking.
 */

import { tgStreamEngine } from './tgStreamEngine';
import type { SubtitleTrackInfo } from './remuxer/ebml';

export interface SubtitleCue {
  trackNumber: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface MSEControllerEvents {
  onReady?: (durationSec: number) => void;
  onError?: (error: string) => void;
  onStatus?: (status: string) => void;
  onAudioUnsupported?: (codecName: string) => void;
  onWaiting?: () => void;
  onPlaying?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onSubtitlesLoaded?: (tracks: SubtitleTrackInfo[]) => void;
  onSubtitleCue?: (cue: SubtitleCue) => void;
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
  private isAudioEvicting = false;
  private evictionInterval: any = null;
  private durationSec = 0;
  private isSeeking = false;
  private pendingSeekTarget: number | null = null;
  private pendingVideoCodec: string | null = null;
  private pendingAudioCodec: string | null = null;
  private lastSentPlayheadTime = -1;
  private videoPlayheadListener: (() => void) | null = null;
  private videoWaitingListener: (() => void) | null = null;
  private isReadySignaled = false;
  private streamId = '';

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
    this.isReadySignaled = false;
    this.streamId = `${channelId}_${messageId}`;

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

    // Automatic micro-gap detection and recovery during playback stalls
    this.videoWaitingListener = () => {
      this.bridgeBufferGap();
    };
    this.video.addEventListener('waiting', this.videoWaitingListener);
    this.video.addEventListener('stalled', this.videoWaitingListener);

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
        const { videoCodec, durationSec, isAudioSupported, audioCodec, audioCodecName, subtitleTracks } = msg;
        this.durationSec = durationSec || 0;

        if (this.durationSec > 0 && this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.duration = this.durationSec;
          } catch (e) {
            // ignore duration write error on live streams
          }
        }

        if (isAudioSupported) {
          const candidateAudioCodec = audioCodec || 'audio/mp4; codecs="mp4a.40.2"';
          if (MediaSource.isTypeSupported(candidateAudioCodec)) {
            this.initAudioSourceBuffer(candidateAudioCodec);
          } else {
            console.warn('Browser MediaSource does not support audio codec:', candidateAudioCodec);
            this.events.onAudioUnsupported?.(audioCodecName || 'AAC');
          }
        } else if (audioCodecName && audioCodecName !== 'None') {
          // Track exists in container (e.g. AC-3, E-AC-3, DTS) but transmuxer cannot package it.
          // Omit audio SourceBuffer to prevent readyState deadlock; notify UI for user toast.
          this.events.onAudioUnsupported?.(audioCodecName);
        }

        if (subtitleTracks && subtitleTracks.length > 0) {
          this.events.onSubtitlesLoaded?.(subtitleTracks);
        }

        // Initialize Video SourceBuffer if not yet created
        this.initSourceBuffer(videoCodec);
        // onReady is deferred until SourceBuffer successfully appends initial media segment
        break;
      }

      case 'SUBTITLE_CUE': {
        this.events.onSubtitleCue?.({
          trackNumber: msg.trackNumber,
          startSec: msg.startSec,
          endSec: msg.endSec,
          text: msg.text,
        });
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

      case 'CANCEL_SEEK_JOBS': {
        const { targetChunk, windowAhead } = msg;
        if (typeof targetChunk === 'number') {
          tgStreamEngine.dropFarJobs(Math.max(0, targetChunk - 4), targetChunk + (windowAhead || 32));
        }
        break;
      }

      case 'DELEGATE_REQUEST_CHUNK': {
        const { requestId, streamId, chunkIndex, urgent } = msg;
        tgStreamEngine.getChunk(streamId, chunkIndex, undefined, urgent !== false)
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
        this.checkReady();
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
        this.checkReady();
      });

      this.audioSourceBuffer.addEventListener('error', (e) => {
        console.warn('Audio SourceBuffer error:', e);
      });
    } catch (e) {
      console.warn('Failed to add audio SourceBuffer:', e);
    }
  }

  public hasAudioTrack(): boolean {
    return this.audioSourceBuffer !== null;
  }

  private enqueueAudioSegment(buf: ArrayBuffer, isPriority = false): void {
    if (!this.audioSourceBuffer) return; // Defensive guard: discard if no audio buffer exists
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
          console.warn('Audio QuotaExceededError: aggressively evicting older buffer segments...');
          this.evictOldBuffers(true);
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
          this.evictOldBuffers(true);
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

    // Abort obsolete MTProto downloads in TgFile immediately
    if (this.streamId) {
      tgStreamEngine.recenterRingBuffer(this.streamId, targetTimeSec, this.durationSec);
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
   * Keeps buffer memory < 80MB by removing already-played content older than 15-20 seconds.
   */
  private startEvictionLoop(): void {
    this.stopEvictionLoop();
    this.evictionInterval = setInterval(() => {
      this.evictOldBuffers(false);
    }, 8000);
  }

  private stopEvictionLoop(): void {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }
  }

  /**
   * Symmetric sliding window buffer eviction:
   * Keeps buffer memory bounded by removing played video and audio content behind the playhead (keeping 15-20s behind).
   * Completely eliminates audio and video QuotaExceededError during continuous playback.
   */
  public evictOldBuffers(forceAggressive = false): void {
    if (!this.isSourceOpen) return;

    const currentPos = this.video.currentTime;
    const retainBehindSec = forceAggressive ? 10 : 20;

    if (currentPos > retainBehindSec) {
      const removeEnd = currentPos - retainBehindSec;

      // Symmetric eviction: Video SourceBuffer
      if (
        this.sourceBuffer &&
        !this.sourceBuffer.updating &&
        !this.isEvicting
      ) {
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

      // Symmetric eviction: Audio SourceBuffer
      if (
        this.audioSourceBuffer &&
        !this.audioSourceBuffer.updating &&
        !this.isAudioEvicting
      ) {
        try {
          this.isAudioEvicting = true;
          this.audioSourceBuffer.remove(0, removeEnd);
          const onAudioEvictEnd = () => {
            this.isAudioEvicting = false;
            this.audioSourceBuffer?.removeEventListener('updateend', onAudioEvictEnd);
            this.flushAudioQueue();
          };
          this.audioSourceBuffer.addEventListener('updateend', onAudioEvictEnd, { once: true });
        } catch (e) {
          this.isAudioEvicting = false;
        }
      }
    }
  }

  public evictBuffer(forceAggressive = false): void {
    this.evictOldBuffers(forceAggressive);
  }

  /**
   * Check if media segments are buffered and signal onReady once.
   * Bridges initial PTS gap if playhead is stuck behind buffered start (e.g. B-frame delay).
   */
  private checkReady(): void {
    if (this.isReadySignaled || !this.isSourceOpen) return;
    if (!this.video || !this.sourceBuffer) return;

    // W3C: video.buffered has valid range only when all active SourceBuffers have data at that range
    if (this.video.buffered && this.video.buffered.length > 0) {
      const startPts = this.video.buffered.start(0);

      // Bridge initial PTS gap if playhead is stuck behind buffered start
      if (this.video.currentTime < startPts) {
        try {
          this.video.currentTime = startPts;
        } catch (e) {
          console.warn('Failed to bridge initial PTS gap:', e);
        }
      }

      this.isReadySignaled = true;
      this.events.onReady?.(this.durationSec);
    }
  }

  /**
   * Micro-gap jumper to recover from sub-frame stalls (<500ms) across cluster boundaries or lead-in offset
   */
  public bridgeBufferGap(): void {
    if (!this.video || !this.video.buffered || this.video.buffered.length === 0) return;
    const ct = this.video.currentTime;
    for (let i = 0; i < this.video.buffered.length; i++) {
      const start = this.video.buffered.start(i);
      // Case 1: Playhead is behind start of buffered range by < 0.5s
      if (ct < start && (start - ct) < 0.5) {
        try {
          this.video.currentTime = start;
        } catch (e) {}
        return;
      }
      // Case 2: Playhead is at the end of range i, and next range (i + 1) starts within 0.5s
      const end = this.video.buffered.end(i);
      if (i + 1 < this.video.buffered.length) {
        const nextStart = this.video.buffered.start(i + 1);
        const gap = nextStart - end;
        if (gap > 0 && gap < 0.5 && ct >= end - 0.1 && ct <= nextStart) {
          try {
            this.video.currentTime = nextStart;
          } catch (e) {}
          return;
        }
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

    if (this.videoWaitingListener) {
      this.video.removeEventListener('waiting', this.videoWaitingListener);
      this.video.removeEventListener('stalled', this.videoWaitingListener);
      this.videoWaitingListener = null;
    }
    this.isEvicting = false;
    this.isAudioEvicting = false;

    this.stopEvictionLoop();
    this.segmentQueue = [];
    this.audioQueue = [];
    this.isSeeking = false;
    this.isReadySignaled = false;
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

