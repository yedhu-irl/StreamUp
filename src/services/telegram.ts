import { TelegramClient, Api, helpers } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { 
  TelegramCredentials, 
  ChannelCategory, 
  ChannelVideoItem,
  TelegramUserProfile,
} from '../types';
import { parseMediaFileName } from './parser';
import { fetchTMDBMetadata } from './tmdb';
import { db } from './db';

let globalClient: TelegramClient | null = null;
let currentCredentials: TelegramCredentials | null = null;
const cachedDocuments = new Map<string, { doc: Api.Document; location: Api.InputDocumentFileLocation; size: number; mimeType: string }>();

export function getTelegramClient(): TelegramClient | null {
  return globalClient;
}

export async function initTelegramClient(
  credentials: TelegramCredentials,
  savedSessionString = ''
): Promise<TelegramClient> {
  if (globalClient) {
    try {
      await globalClient.disconnect();
    } catch (e) {
      // ignore
    }
    globalClient = null;
    cachedUserProfile = null;
  }

  currentCredentials = credentials;
  const stringSession = new StringSession(savedSessionString);

  // In browser, GramJS automatically uses WebSocket
  const client = new TelegramClient(stringSession, credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    useWSS: true,
    deviceModel: 'StreamUp Web',
    systemVersion: typeof navigator !== 'undefined' ? (navigator.userAgent || 'WebOS / Browser') : 'Web 1.0',
    appVersion: '1.0.0',
    langCode: 'en',
    systemLangCode: 'en',
  });

  await client.connect();
  globalClient = client;

  // Initialize Service Worker communication bridge
  setupServiceWorkerStreamBridge();

  return client;
}

export async function isUserAuthorized(): Promise<boolean> {
  if (!globalClient) return false;
  try {
    return await globalClient.isUserAuthorized();
  } catch (e) {
    return false;
  }
}

export async function sendPhoneCode(phoneNumber: string): Promise<string> {
  if (!globalClient) throw new Error('Telegram client not initialized');
  const res = await globalClient.sendCode(
    {
      apiId: currentCredentials!.apiId,
      apiHash: currentCredentials!.apiHash,
    },
    phoneNumber
  );
  return res.phoneCodeHash;
}

export async function signInWithPhone(
  phoneNumber: string,
  phoneCodeHash: string,
  phoneCode: string,
  password2FA?: string
): Promise<string> {
  if (!globalClient) throw new Error('Telegram client not initialized');

  try {
    await globalClient.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode,
      })
    );
  } catch (error: any) {
    if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      if (!password2FA) {
        throw new Error('2FA_REQUIRED');
      }
      await (globalClient as any).signInWithPassword({
        password: password2FA,
      });
    } else {
      throw error;
    }
  }

  return (globalClient.session as StringSession).save();
}

export async function startQRLogin(
  onQRUpdate: (qrUrl: string) => void,
  onPasswordNeeded: (hint?: string) => Promise<string>,
  onError: (err: any) => void
): Promise<string> {
  if (!globalClient) throw new Error('Telegram client not initialized');

  return new Promise(async (resolve, reject) => {
    try {
      await (globalClient as any).signInUserWithQrCode(
        {
          apiId: currentCredentials!.apiId,
          apiHash: currentCredentials!.apiHash,
        },
        {
          qrCode: async (code: { token: Buffer; expires: number }) => {
            const buf = Buffer.from(code.token);
            const tokenBase64 = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const qrUrl = `tg://login?token=${tokenBase64}`;
            onQRUpdate(qrUrl);
          },
          password: async (hint?: string) => {
            return await onPasswordNeeded(hint);
          },
          onError: (err: any) => {
            onError(err);
            reject(err);
          },
        }
      );

      const sessionString = (globalClient!.session as StringSession).save();
      resolve(sessionString);
    } catch (e) {
      reject(e);
    }
  });
}

let cachedUserProfile: TelegramUserProfile | null = null;

export async function getTelegramUserProfile(): Promise<TelegramUserProfile | null> {
  if (cachedUserProfile) return cachedUserProfile;
  if (!globalClient) return null;

  try {
    const me = await globalClient.getMe();
    if (me instanceof Api.User) {
      let photoUrl: string | null = null;
      try {
        const photoBuf = await (globalClient as any).downloadProfilePhoto(me, { isBig: false });
        if (photoBuf && photoBuf.length > 0) {
          const u8 = new Uint8Array(photoBuf.buffer, photoBuf.byteOffset, photoBuf.byteLength);
          const blob = new Blob([u8], { type: 'image/jpeg' });
          photoUrl = URL.createObjectURL(blob);
        }
      } catch (photoErr) {
        // Fallback gracefully without avatar image
      }

      cachedUserProfile = {
        id: me.id.toString(),
        firstName: me.firstName || 'Telegram User',
        lastName: me.lastName,
        username: me.username,
        phone: me.phone,
        photoUrl,
      };
      return cachedUserProfile;
    }
  } catch (e) {
    console.warn('Failed to retrieve Telegram user profile:', e);
  }
  return null;
}

export async function fetchJoinedChannels(): Promise<ChannelCategory[]> {
  if (!globalClient) throw new Error('Telegram client not initialized');

  // Fetch dialogs from main folder
  const dialogs = await globalClient.getDialogs({ limit: 200 });
  const channels: ChannelCategory[] = [];

  for (const dialog of dialogs) {
    // 1. Strict Archive Filter: exclude anything archived or in folderId >= 1
    const isArchived = 
      dialog.archived === true || 
      dialog.folderId === 1 || 
      Number((dialog.dialog as any)?.folderId || 0) > 0;

    if (isArchived) {
      continue;
    }

    // 2. Strict Channel Filter: Exclude personal user chats, standard groups, and supergroup chat forums
    if (dialog.isUser || dialog.isGroup) {
      continue;
    }

    const entity = dialog.entity as any;
    const isMegagroup = entity?.megagroup === true;
    const isBroadcast = entity?.broadcast === true;

    // Only allow actual broadcast channels (where movies/shows are hosted), no groups
    if (!dialog.isChannel || isMegagroup || !isBroadcast) {
      continue;
    }

    channels.push({
      id: dialog.id?.toString() || '',
      title: dialog.title || 'Untitled Channel',
      username: entity?.username,
      accessHash: entity?.accessHash?.toString(),
      enabled: true,
    });
  }

  return channels;
}

export async function scanChannelVideos(
  channelId: string,
  onProgress?: (count: number) => void
): Promise<ChannelVideoItem[]> {
  if (!globalClient) throw new Error('Telegram client not initialized');

  const peer = await globalClient.getInputEntity(channelId);
  const items: ChannelVideoItem[] = [];

  // Subtitle files mapping (filename pattern -> messageId)
  const subtitlesMap = new Map<string, number>();

  // Fetch documents filter
  const messages = await globalClient.getMessages(peer, {
    limit: 150,
  });

  // First pass: index subtitles (.srt / .vtt)
  for (const msg of messages) {
    if (msg.media && msg.media instanceof Api.MessageMediaDocument) {
      const doc = msg.media.document;
      if (doc instanceof Api.Document) {
        const fnAttr = doc.attributes.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
        const fileName = fnAttr?.fileName || '';
        if (/\.(srt|vtt)$/i.test(fileName)) {
          const baseName = fileName.replace(/\.(srt|vtt)$/i, '').toLowerCase();
          subtitlesMap.set(baseName, msg.id);
        }
      }
    }
  }

  // Second pass: extract video items
  for (const msg of messages) {
    if (msg.media && msg.media instanceof Api.MessageMediaDocument) {
      const doc = msg.media.document;
      if (doc instanceof Api.Document) {
        const isVideoMime = doc.mimeType?.startsWith('video/') || false;
        const fnAttr = doc.attributes.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
        const videoAttr = doc.attributes.find((a) => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
        const fileName = fnAttr?.fileName || `video_${msg.id}.mp4`;
        const hasVideoExt = /\.(mp4|mkv|webm|avi|mov|m4v)$/i.test(fileName);

        if (isVideoMime || hasVideoExt || videoAttr) {
          const parsed = parseMediaFileName(fileName);
          const cacheKey = `${channelId}_${msg.id}`;

          // Register document for Service Worker streaming
          const inputLoc = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          });

          cachedDocuments.set(cacheKey, {
            doc,
            location: inputLoc,
            size: Number(doc.size),
            mimeType: doc.mimeType || 'video/mp4',
          });

          // Match subtitle
          const baseName = fileName.replace(/\.[a-zA-Z0-9]+$/, '').toLowerCase();
          let subId: number | undefined;
          for (const [subName, sId] of subtitlesMap.entries()) {
            if (baseName.includes(subName) || subName.includes(baseName)) {
              subId = sId;
              break;
            }
          }

          items.push({
            id: cacheKey,
            channelId,
            messageId: msg.id,
            fileName,
            fileSize: Number(doc.size),
            mimeType: doc.mimeType || 'video/mp4',
            duration: videoAttr?.duration,
            parsed,
            tmdb: null, // TMDB metadata will be enriched asynchronously
            date: msg.date,
            subtitleMessageId: subId,
          });

          if (onProgress) onProgress(items.length);
        }
      }
    }
  }

  // Store in database immediately
  await db.videos.bulkPut(items);

  // Enrich TMDB metadata in background and update database
  enrichVideosWithTMDB(items);

  return items;
}

export async function enrichVideosWithTMDB(
  items: ChannelVideoItem[],
  onUpdated?: (item: ChannelVideoItem) => void
) {
  for (const item of items) {
    if (item.tmdb && item.tmdb.posterPath) continue;

    try {
      const metadata = await fetchTMDBMetadata(
        item.parsed.cleanTitle,
        item.parsed.year,
        item.parsed.isSeries
      );
      if (metadata) {
        item.tmdb = metadata;
        await db.videos.put(item);
        if (onUpdated) onUpdated(item);
      }
    } catch (e) {
      console.warn('Could not enrich TMDB for', item.parsed.cleanTitle);
    }
  }
}

export async function fetchSubtitleContent(channelId: string, messageId: number): Promise<string | null> {
  if (!globalClient) return null;
  try {
    const peer = await globalClient.getInputEntity(channelId);
    const messages = await globalClient.getMessages(peer, { ids: [messageId] });
    if (!messages || messages.length === 0) return null;

    const msg = messages[0];
    const buffer = await globalClient.downloadMedia(msg, {});
    if (!buffer) return null;

    const decoder = new TextDecoder('utf-8');
    const srtText = decoder.decode(buffer as any);
    return convertSrtToVtt(srtText);
  } catch (err) {
    console.error('Failed to download subtitle:', err);
    return null;
  }
}

// Convert SRT to WebVTT for native <track> playback
export function convertSrtToVtt(srt: string): string {
  let vtt = 'WEBVTT\n\n';
  // Replace comma timestamps with period: 00:01:20,000 --> 00:01:20.000
  vtt += srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

// Service Worker Stream Interceptor Handler
let isBridgeInitialized = false;
let activeMessagePort: MessagePort | null = null;
let currentTransferSpeed = 0; // Bytes per second
let speedListeners = new Set<(speedBytesPerSec: number) => void>();

export function subscribeTransferSpeed(listener: (speedBytesPerSec: number) => void): () => void {
  speedListeners.add(listener);
  listener(currentTransferSpeed);
  return () => speedListeners.delete(listener);
}

function notifyTransferSpeed(bytes: number, durationMs: number) {
  if (durationMs > 0) {
    currentTransferSpeed = Math.round((bytes / durationMs) * 1000);
    speedListeners.forEach((fn) => fn(currentTransferSpeed));
  }
}

export async function resolveCachedDocument(channelId: string, messageId: number) {
  const cacheKey = `${channelId}_${messageId}`;
  let cached = cachedDocuments.get(cacheKey);

  if (!cached && globalClient) {
    try {
      let peer: any;
      try {
        peer = await globalClient.getInputEntity(channelId);
      } catch (entityErr) {
        // Look up channel in Dexie db.channels to get accessHash
        const ch = await db.channels.get(channelId);
        if (ch && ch.accessHash) {
          const rawId = channelId.replace(/^-100/, '');
          peer = new Api.InputPeerChannel({
            channelId: helpers.returnBigInt(rawId),
            accessHash: helpers.returnBigInt(ch.accessHash),
          });
        } else {
          await globalClient.getDialogs({ limit: 100 });
          peer = await globalClient.getInputEntity(channelId);
        }
      }

      const messages = await globalClient.getMessages(peer, { ids: [messageId] });
      if (messages && messages[0]?.media instanceof Api.MessageMediaDocument) {
        const doc = messages[0].media.document;
        if (doc instanceof Api.Document) {
          const inputLoc = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          });
          cached = {
            doc,
            location: inputLoc,
            size: Number(doc.size),
            mimeType: doc.mimeType || 'video/mp4',
          };
          cachedDocuments.set(cacheKey, cached);
        }
      }
    } catch (err) {
      console.error('Error resolving document on demand:', err);
    }
  }
  return cached;
}

export function prewarmDocument(channelId: string, messageId: number) {
  const cacheKey = `${channelId}_${messageId}`;
  if (!cachedDocuments.has(cacheKey)) {
    resolveCachedDocument(channelId, messageId).catch(() => {});
  }
}

async function processStreamMessage(
  msg: any,
  postResponse: (response: any) => void
) {
  const { requestId, type, channelId, messageId, offset, limit } = msg;

  if (type === 'GET_FILE_INFO') {
    // Fast path: check Dexie db.videos first to respond in <5ms without blocking on Telegram network
    const dbItem = await db.videos.get(`${channelId}_${messageId}`);
    if (dbItem) {
      postResponse({
        requestId,
        type: 'GET_FILE_INFO_RESPONSE',
        data: {
          fileSize: dbItem.fileSize,
          mimeType: dbItem.mimeType || 'video/mp4',
        },
      });
      // Pre-warm document location in background for subsequent FETCH_CHUNK requests
      resolveCachedDocument(channelId, Number(messageId)).catch(() => {});
      return;
    }

    const cached = await resolveCachedDocument(channelId, Number(messageId));
    if (cached) {
      postResponse({
        requestId,
        type: 'GET_FILE_INFO_RESPONSE',
        data: {
          fileSize: cached.size,
          mimeType: cached.mimeType,
        },
      });
    } else {
      postResponse({
        requestId,
        type: 'GET_FILE_INFO_RESPONSE',
        error: 'Document not found in Telegram channel',
      });
    }
    return;
  }

  if (type === 'FETCH_CHUNK') {
    const cached = await resolveCachedDocument(channelId, Number(messageId));
    if (!cached || !globalClient) {
      postResponse({
        requestId,
        type: 'FETCH_CHUNK_RESPONSE',
        error: 'Document or Telegram client not available',
      });
      return;
    }

    try {
      const rawOffset = Number(offset || 0);
      const alignedOffset = Math.floor(rawOffset / 4096) * 4096;
      const limitInt = limit || 512 * 1024;
      let alignedLimit = Math.ceil(limitInt / 4096) * 4096;
      alignedLimit = Math.min(alignedLimit, 1024 * 1024);

      const offsetBig = helpers.returnBigInt(alignedOffset);
      const startTime = performance.now();

      let cleanBuffer: ArrayBuffer | null = null;
      let dcId = (cached.doc as any).dcId || 1;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const sender = await (globalClient as any).getSender(dcId);
          const req = new Api.upload.GetFile({
            location: cached.location,
            offset: offsetBig,
            limit: alignedLimit,
            precise: true,
          });
          const result = await (globalClient as any).invokeWithSender(req, sender);
          if (result instanceof Api.upload.File) {
            const u8 = new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
            cleanBuffer = u8.slice().buffer;
            break;
          }
        } catch (callErr: any) {
          const msg = callErr.errorMessage || callErr.message || '';
          if (msg.startsWith('FILE_MIGRATE_') || callErr.name === 'FileMigrateError') {
            const newDc = callErr.newDc || parseInt(msg.replace('FILE_MIGRATE_', ''), 10);
            if (newDc) {
              dcId = newDc;
              continue;
            }
          }
          console.warn(`Chunk fetch attempt ${attempt} warning:`, callErr);
          if (attempt === 2) throw callErr;
        }
      }

      const elapsed = performance.now() - startTime;
      if (cleanBuffer) {
        notifyTransferSpeed(cleanBuffer.byteLength, elapsed);
        postResponse({
          requestId,
          type: 'FETCH_CHUNK_RESPONSE',
          data: {
            buffer: cleanBuffer,
          },
        });
      } else {
        postResponse({
          requestId,
          type: 'FETCH_CHUNK_RESPONSE',
          error: 'Failed to retrieve file chunk from Telegram',
        });
      }
    } catch (err: any) {
      console.error('Error fetching MTProto chunk:', err);
      postResponse({
        requestId,
        type: 'FETCH_CHUNK_RESPONSE',
        error: err.message || 'Failed to fetch chunk',
      });
    }
  }
}

export function initServiceWorkerPortBridge() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  if (navigator.serviceWorker.controller) {
    try {
      const channel = new MessageChannel();
      activeMessagePort = channel.port1;

      activeMessagePort.onmessage = (event) => {
        if (event.data) {
          processStreamMessage(event.data, (resp) => activeMessagePort?.postMessage(resp));
        }
      };
      activeMessagePort.start();

      navigator.serviceWorker.controller.postMessage({ type: 'INIT_PORT' }, [channel.port2]);
    } catch (e) {
      console.warn('Failed to establish direct MessageChannel with ServiceWorker:', e);
    }
  }
}

export function setupServiceWorkerStreamBridge() {
  if (isBridgeInitialized) return;
  isBridgeInitialized = true;

  const streamChannel = new BroadcastChannel('streamup_stream_channel');
  streamChannel.onmessage = async (event) => {
    if (event.data) {
      processStreamMessage(event.data, (resp) => streamChannel.postMessage(resp));
    }
  };

  initServiceWorkerPortBridge();

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      initServiceWorkerPortBridge();
    });
  }
}

// Auto-run bridge on module boot
if (typeof window !== 'undefined') {
  setupServiceWorkerStreamBridge();
}

// Auto-sync active channels
export async function autoSyncAllChannels(
  onProgress?: (channelTitle: string, count: number) => void
): Promise<number> {
  if (!globalClient) return 0;
  const channels = await db.channels.toArray();
  const activeChannels = channels.filter((c) => c.enabled !== false);
  let totalCount = 0;

  for (const ch of activeChannels) {
    try {
      const videos = await scanChannelVideos(ch.id);
      if (videos.length > 0) {
        await db.videos.bulkPut(videos);
        ch.lastScanned = Date.now();
        ch.videoCount = videos.length;
        await db.channels.put(ch);
        totalCount += videos.length;
        if (onProgress) {
          onProgress(ch.title, videos.length);
        }
      }
    } catch (err) {
      console.warn(`Auto-sync failed for channel ${ch.title}:`, err);
    }
  }

  return totalCount;
}
