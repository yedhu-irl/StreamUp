/**
 * MSE Stream Engine
 *
 * Replaces the Service Worker / HTTP-206 approach.
 * Fetches Telegram file chunks via GramJS iterDownload() and feeds
 * them directly into a MediaSource SourceBuffer — no proxy, no SW,
 * no MIME sniffing issues with MKV files.
 *
 * Why this works where the SW approach fails:
 *   - The browser's <video> element rejects video/x-matroska even
 *     with a valid 206 stream because it cannot demux the container.
 *   - With MSE we manually declare the codec string, and for MKV
 *     files whose inner streams are H.264 + AAC we just lie and call
 *     them 'video/mp4' — the browser's MSE parser accepts the raw
 *     bitstream regardless of the outer container wrapper.
 *   - For true WebM/VP9 we use the 'video/webm' codec string.
 */

import { Api, helpers } from 'telegram';
import { getTelegramClient } from './telegram';

/** Preferred MSE MIME + codec strings, tried in order. */
const CODEC_CANDIDATES = [
  'video/mp4; codecs="avc1.64002a, mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
  'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
  'video/webm; codecs="vp9, opus"',
  'video/webm; codecs="vp8, vorbis"',
  'video/mp4',
  'video/webm',
];

function pickMimeForMSE(fileMime: string): string {
  // If the Telegram MIME is webm-family, prefer webm codec strings
  if (fileMime.includes('webm')) {
    return (
      CODEC_CANDIDATES.find(
        (c) => c.startsWith('video/webm') && MediaSource.isTypeSupported(c)
      ) ||
      CODEC_CANDIDATES.find((c) => MediaSource.isTypeSupported(c)) ||
      'video/mp4'
    );
  }
  // For mkv / mp4 / avi / default — try avc1 first
  return (
    CODEC_CANDIDATES.find((c) => MediaSource.isTypeSupported(c)) || 'video/mp4'
  );
}

export interface MSEStreamHandle {
  /** Call when the player component unmounts / stops */
  destroy: () => void;
  /** Call when user seeks. Pass target time in seconds. */
  seek: (timeSeconds: number) => void;
}

/**
 * Attach a Telegram file to a <video> element via MSE.
 *
 * @param videoEl  The target <video> DOM element
 * @param channelId  Telegram channel/chat ID string
 * @param messageId  Telegram message ID
 * @param fileSize  File size in bytes (from IndexedDB)
 * @param fileMime  MIME type from Telegram document (e.g. video/x-matroska)
 * @param initialTime  Resume position in seconds (0 for fresh play)
 * @param onError  Called with a human-readable error string on failure
 * @param onReady  Called once the MediaSource is open and streaming starts
 * @returns  MSEStreamHandle to destroy/seek, or null on init failure
 */
export async function attachMSEStream(
  videoEl: HTMLVideoElement,
  channelId: string,
  messageId: number,
  fileSize: number,
  fileMime: string,
  initialTime: number,
  onError: (msg: string) => void,
  onReady?: () => void,
): Promise<MSEStreamHandle | null> {
  const client = getTelegramClient();
  if (!client) {
    onError('Telegram client not available. Please reload the page.');
    return null;
  }

  // Resolve the Document and InputDocumentFileLocation from GramJS
  let resolvedDoc: Api.Document;
  let totalSize = fileSize;

  try {
    let peer: any;
    try {
      peer = await client.getInputEntity(channelId);
    } catch {
      await client.getDialogs({ limit: 100 });
      peer = await client.getInputEntity(channelId);
    }

    const messages = await client.getMessages(peer, { ids: [messageId] });
    if (!messages || !messages[0]?.media) {
      onError('Video not found in Telegram channel. Try rescanning.');
      return null;
    }

    const media = messages[0].media;
    if (!(media instanceof Api.MessageMediaDocument)) {
      onError('Media is not a document.');
      return null;
    }

    const doc = media.document;
    if (!(doc instanceof Api.Document)) {
      onError('Invalid Telegram document.');
      return null;
    }

    resolvedDoc = doc;
    totalSize = Number(doc.size) || fileSize;
    fileMime = doc.mimeType || fileMime;
  } catch (err: any) {
    onError(`Failed to resolve Telegram document: ${err.message}`);
    return null;
  }

  const mseCodec = pickMimeForMSE(fileMime);

  // --- MSE setup ---
  if (!('MediaSource' in window)) {
    onError('MediaSource Extensions not supported in this browser.');
    return null;
  }
  if (!MediaSource.isTypeSupported(mseCodec)) {
    onError(
      `Codec not supported by browser MSE: ${mseCodec}. ` +
      `For MKV/HEVC files, use Chrome 120+ or webOS TV native player.`
    );
    return null;
  }

  const mediaSource = new MediaSource();
  let sourceBuffer: SourceBuffer | null = null;
  let destroyed = false;
  let currentIterator: AsyncGenerator<Buffer, any, unknown> | null = null;
  let seekPending = false;
  let seekTargetTime = 0;
  let appendQueue: Uint8Array[] = [];
  let isAppending = false;

  // Byte-offset estimation: linear (aligned to Telegram 4096-byte boundary)
  function estimateByteOffset(timeSeconds: number) {
    if (totalSize <= 0) return helpers.returnBigInt(0);
    const duration = videoEl.duration || 0;
    if (duration <= 0) return helpers.returnBigInt(0);
    const ratio = Math.max(0, Math.min(1, timeSeconds / duration));
    const rawByte = Math.floor(ratio * totalSize);
    const aligned = Math.floor(rawByte / 4096) * 4096;
    return helpers.returnBigInt(aligned);
  }

  async function processAppendQueue() {
    if (isAppending || !sourceBuffer || seekPending) return;
    if (appendQueue.length === 0) return;
    isAppending = true;

    while (appendQueue.length > 0 && !seekPending && !destroyed) {
      const chunk = appendQueue.shift()!;
      if (sourceBuffer.updating) {
        await new Promise<void>((r) =>
          sourceBuffer!.addEventListener('updateend', () => r(), { once: true })
        );
      }
      if (seekPending || destroyed) break;
      try {
        sourceBuffer.appendBuffer(chunk.buffer as ArrayBuffer);
        await new Promise<void>((r) =>
          sourceBuffer!.addEventListener('updateend', () => r(), { once: true })
        );
      } catch (e: any) {
        // QuotaExceededError: evict old buffered range
        if (e.name === 'QuotaExceededError' && sourceBuffer.buffered.length > 0) {
          const evictEnd = Math.max(0, (videoEl.currentTime || 0) - 30);
          if (evictEnd > 0 && !sourceBuffer.updating) {
            try {
              sourceBuffer.remove(0, evictEnd);
              await new Promise<void>((r) =>
                sourceBuffer!.addEventListener('updateend', () => r(), { once: true })
              );
            } catch (_) {}
            // Re-queue the chunk
            appendQueue.unshift(chunk);
          }
        } else {
          console.warn('MSE appendBuffer error:', e);
        }
      }
    }
    isAppending = false;
  }

  async function startStreaming(offsetBig: any) {
    if (!client || destroyed) return;
    seekPending = false;

    // Clear any pending queue from previous iteration
    appendQueue = [];

    // Abort & clear any existing source buffer data around seek point
    if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
      try {
        if (sourceBuffer.buffered.length > 0) {
          const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          // Only remove if there's something to remove outside current position
          if (end > 0.5) {
            sourceBuffer.remove(0, Math.max(0, videoEl.currentTime - 2));
          }
        }
      } catch (_) {}
    }

    try {
      const iter = (client as any).iterDownload({
        file: resolvedDoc,
        offset: offsetBig,
        requestSize: 512 * 1024, // 512KB — aligned to Telegram's 4096-byte requirement
      });
      currentIterator = iter;

      for await (const rawChunk of iter) {
        if (destroyed || seekPending) {
          break;
        }

        // rawChunk is a Buffer from GramJS — extract clean ArrayBuffer
        const u8 = new Uint8Array(
          rawChunk.buffer,
          rawChunk.byteOffset,
          rawChunk.byteLength
        );
        // Ensure clean ArrayBuffer (not SharedArrayBuffer) for SourceBuffer.appendBuffer
        const cleanU8 = new Uint8Array(u8.byteLength);
        cleanU8.set(u8);
        appendQueue.push(cleanU8);
        processAppendQueue();
      }

      // Stream finished
      if (!seekPending && !destroyed && mediaSource.readyState === 'open') {
        // Wait for all chunks to be appended
        while (appendQueue.length > 0 || isAppending) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!seekPending && !destroyed && mediaSource.readyState === 'open') {
          try {
            mediaSource.endOfStream();
          } catch (_) {}
        }
      }
    } catch (err: any) {
      if (!destroyed && !seekPending) {
        console.error('MSE stream error:', err);
        onError(`Stream error: ${err.message || 'Unknown error'}`);
      }
    }
  }

  mediaSource.addEventListener('sourceopen', async () => {
    if (destroyed) return;
    URL.revokeObjectURL(videoEl.src);

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mseCodec);
      sourceBuffer.mode = 'segments';
    } catch (e: any) {
      onError(`Failed to add SourceBuffer (${mseCodec}): ${e.message}`);
      return;
    }

    if (onReady) onReady();

    const startOffset = initialTime > 0 ? estimateByteOffset(initialTime) : helpers.returnBigInt(0);
    await startStreaming(startOffset);
  });

  videoEl.src = URL.createObjectURL(mediaSource);

  // Handle seek events from user scrubbing
  const handleSeeking = () => {
    seekPending = true;
    appendQueue = [];
    // Abort current source buffer operation
    if (sourceBuffer && sourceBuffer.updating) {
      try { sourceBuffer.abort(); } catch (_) {}
    }
    const targetByte = estimateByteOffset(videoEl.currentTime);
    // Debounce: wait 200ms in case user is still dragging
    setTimeout(() => {
      if (!destroyed) {
        startStreaming(targetByte);
      }
    }, 200);
  };

  videoEl.addEventListener('seeking', handleSeeking);

  return {
    destroy() {
      destroyed = true;
      seekPending = true;
      videoEl.removeEventListener('seeking', handleSeeking);
      try {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      } catch (_) {}
    },
    seek(timeSeconds: number) {
      seekTargetTime = timeSeconds;
      seekPending = true;
      appendQueue = [];
      if (sourceBuffer && sourceBuffer.updating) {
        try { sourceBuffer.abort(); } catch (_) {}
      }
      const targetByte = estimateByteOffset(timeSeconds);
      setTimeout(() => {
        if (!destroyed) {
          startStreaming(targetByte);
        }
      }, 100);
    },
  };
}
