// public/sw-stream.js
// Dedicated Service Worker HTTP 206 Partial Content Range Proxy for Telegram Video Streams

const CHUNK_SIZE = 512 * 1024; // 524,288 bytes (strictly 512 KB)
const MAX_RANGE_WINDOW = 4 * CHUNK_SIZE; // 2 MB window cap on open-ended ranges

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// BroadcastChannel for communicating with Main Thread TgStreamEngine
const rpcChannel = new BroadcastChannel('tg-stream-rpc');
const pendingRequests = new Map();

rpcChannel.onmessage = (event) => {
  const { type, requestId, data, error } = event.data || {};
  if ((type === 'CHUNK_RESPONSE' || type === 'DESCRIPTOR_RESPONSE') && requestId) {
    const resolver = pendingRequests.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      pendingRequests.delete(requestId);
      if (error) {
        resolver.reject(new Error(error));
      } else {
        resolver.resolve(data);
      }
    }
  }
};

/**
 * Open IndexedDB directly inside the Service Worker for instant, zero-IPC chunk reads.
 */
function openStreamDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('StreamUpMediaDB', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('videoChunks')) {
        db.createObjectStore('videoChunks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('streamDescriptors')) {
        db.createObjectStore('streamDescriptors', { keyPath: 'streamId' });
      }
    };
  });
}

async function getChunkFromIndexedDB(chunkKey) {
  try {
    const db = await openStreamDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction('videoChunks', 'readonly');
      const store = tx.objectStore('videoChunks');
      const req = store.get(chunkKey);
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function getStreamDescriptorFromIndexedDB(streamId) {
  try {
    const db = await openStreamDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction('streamDescriptors', 'readonly');
      const store = tx.objectStore('streamDescriptors');
      const req = store.get(streamId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function requestChunkFromMainThread(streamId, chunkIndex, timeoutMs = 20000) {
  const requestId = `sw_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Timeout requesting chunk ${chunkIndex} from Main Thread`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    rpcChannel.postMessage({
      type: 'REQUEST_CHUNK',
      requestId,
      streamId,
      chunkIndex,
    });
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Health check barrier
  if (url.pathname === '/tg-stream/ping') {
    event.respondWith(new Response('ok', { status: 200 }));
    return;
  }

  // TMPlayer API: GET /api/files/:id (Metadata Contract)
  const metaMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (metaMatch) {
    const streamId = decodeURIComponent(metaMatch[1]);
    event.respondWith(handleFileMetadataRequest(streamId));
    return;
  }

  // TMPlayer API: GET /api/files/:id/stream (HTTP 206 Range Stream)
  const fileStreamMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/stream$/);
  if (fileStreamMatch) {
    const streamId = decodeURIComponent(fileStreamMatch[1]);
    event.respondWith(handleStreamRequest(event.request, streamId));
    return;
  }

  // Range Proxy route: /api/stream/:streamId
  const apiStreamMatch = url.pathname.match(/^\/api\/stream\/([^/]+)/);
  if (apiStreamMatch) {
    const streamId = decodeURIComponent(apiStreamMatch[1]);
    event.respondWith(handleStreamRequest(event.request, streamId));
    return;
  }

  // Range Proxy route: /tg-stream/:streamId
  const match = url.pathname.match(/^\/tg-stream\/([^/]+)/);
  if (match) {
    const streamId = decodeURIComponent(match[1]);
    event.respondWith(handleStreamRequest(event.request, streamId));
    return;
  }

  // Legacy route fallback: /stream/:channelId/:messageId
  const legacyMatch = url.pathname.match(/^\/stream\/([^/]+)\/(\d+)/);
  if (legacyMatch) {
    const streamId = `${decodeURIComponent(legacyMatch[1])}_${legacyMatch[2]}`;
    event.respondWith(handleStreamRequest(event.request, streamId));
    return;
  }
});

async function handleFileMetadataRequest(streamId) {
  let descriptor = await getStreamDescriptorFromIndexedDB(streamId);
  if (!descriptor || !descriptor.totalSize) {
    descriptor = await requestDescriptorFromMainThread(streamId);
  }
  if (!descriptor) {
    return new Response(JSON.stringify({ error: 'File metadata not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const payload = {
    id: descriptor.streamId,
    name: descriptor.fileName || 'media',
    mimeType: descriptor.mimeType || 'video/mp4',
    size: descriptor.totalSize || 0,
    duration: descriptor.duration || 0,
    streamUrl: `/api/files/${encodeURIComponent(descriptor.streamId)}/stream`,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache',
      'Access-Control-Allow-Origin': self.location.origin,
    },
  });
}

async function requestDescriptorFromMainThread(streamId, timeoutMs = 8000) {
  const requestId = `desc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject: () => resolve(null), timer });
    rpcChannel.postMessage({ type: 'REQUEST_DESCRIPTOR', requestId, streamId });
  });
}

async function handleStreamRequest(request, streamId) {
  let descriptor = await getStreamDescriptorFromIndexedDB(streamId);
  if (!descriptor || !descriptor.totalSize) {
    descriptor = await requestDescriptorFromMainThread(streamId);
  }
  if (!descriptor || !descriptor.totalSize) {
    return new Response('Stream descriptor not found', { status: 404 });
  }

  const { totalSize, mimeType } = descriptor;
  const rangeHeader = request.headers.get('Range');
  const reqUrl = new URL(request.url);
  const qOffset = reqUrl.searchParams.get('offset');
  const qLimit = reqUrl.searchParams.get('limit');

  let start = 0;
  let end = totalSize - 1;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      if (match[2]) {
        end = parseInt(match[2], 10);
      } else {
        // Cap open-ended range to 2 MB window
        end = Math.min(start + MAX_RANGE_WINDOW - 1, totalSize - 1);
      }
    }
  } else if (qOffset !== null) {
    start = parseInt(qOffset, 10) || 0;
    if (qLimit !== null) {
      end = Math.min(start + parseInt(qLimit, 10) - 1, totalSize - 1);
    } else {
      end = Math.min(start + MAX_RANGE_WINDOW - 1, totalSize - 1);
    }
  } else {
    // No range header: serve first 512 KB
    end = Math.min(CHUNK_SIZE - 1, totalSize - 1);
  }

  if (start >= totalSize) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    });
  }

  end = Math.min(end, totalSize - 1);
  const contentLength = end - start + 1;

  const startChunk = Math.floor(start / CHUNK_SIZE);
  const endChunk = Math.floor(end / CHUNK_SIZE);

  let currentChunk = startChunk;
  let isClosed = false;

  const stream = new ReadableStream({
    async pull(controller) {
      if (isClosed || currentChunk > endChunk) {
        controller.close();
        isClosed = true;
        return;
      }

      // Check client abort
      if (request.signal && request.signal.aborted) {
        controller.close();
        isClosed = true;
        return;
      }

      const c = currentChunk;
      currentChunk++;

      try {
        const chunkKey = `${streamId}_${c}`;
        // 1. Zero-IPC direct read from IndexedDB
        let chunkData = await getChunkFromIndexedDB(chunkKey);

        // 2. Fallback to Main Thread GramJS RPC
        if (!chunkData) {
          chunkData = await requestChunkFromMainThread(streamId, c);
        }

        if (!chunkData || chunkData.byteLength === 0) {
          controller.close();
          isClosed = true;
          return;
        }

        const chunkByteStart = c * CHUNK_SIZE;
        const sliceStart = Math.max(0, start - chunkByteStart);
        const sliceEnd = Math.min(chunkData.byteLength, end - chunkByteStart + 1);

        if (sliceStart < chunkData.byteLength && sliceStart < sliceEnd) {
          const slice = chunkData.subarray(sliceStart, sliceEnd);
          controller.enqueue(slice);
        }

        if (c >= endChunk) {
          controller.close();
          isClosed = true;
        }
      } catch (err) {
        controller.error(err);
        isClosed = true;
      }
    },
    cancel() {
      isClosed = true;
    },
  });

  return new Response(stream, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': mimeType || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': contentLength.toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': self.location.origin,
    },
  });
}
