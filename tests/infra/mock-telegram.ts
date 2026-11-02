/**
 * tests/infra/mock-telegram.ts
 * In-memory MTProto chunk repository and network simulator for Telegram stream streaming.
 */

export interface MockTelegramStreamOptions {
  chunkSize?: number;
  simulatedRttMs?: number;
  simulateTimeout?: boolean;
  simulateDropAfterChunk?: number;
}

export class MockTelegramEngine {
  private streams: Map<string, Uint8Array> = new Map();
  private options: MockTelegramStreamOptions;
  public totalChunksFetched = 0;
  public fetchLog: Array<{ offset: number; size: number; timestamp: number }> = [];

  constructor(options: MockTelegramStreamOptions = {}) {
    this.options = {
      chunkSize: 512 * 1024,
      simulatedRttMs: 10,
      simulateTimeout: false,
      simulateDropAfterChunk: -1,
      ...options,
    };
  }

  public registerStreamData(streamId: string, data: Uint8Array): void {
    this.streams.set(streamId, data);
  }

  public async fetchChunk(
    streamId: string,
    offset: number,
    size: number
  ): Promise<ArrayBuffer> {
    this.totalChunksFetched++;
    this.fetchLog.push({ offset, size, timestamp: Date.now() });

    if (this.options.simulateTimeout) {
      await new Promise((r) => setTimeout(r, 2000));
      throw new Error('Telegram MTProto connection timed out (FLOOD_WAIT / TIMEOUT)');
    }

    if (
      this.options.simulateDropAfterChunk !== undefined &&
      this.options.simulateDropAfterChunk >= 0 &&
      this.totalChunksFetched > this.options.simulateDropAfterChunk
    ) {
      throw new Error('Network connection dropped: Telegram DC socket closed abruptly');
    }

    if (this.options.simulatedRttMs && this.options.simulatedRttMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.simulatedRttMs));
    }

    const fullData = this.streams.get(streamId);
    if (!fullData) {
      throw new Error(`Stream ${streamId} not found in mock Telegram store`);
    }

    if (offset >= fullData.length) {
      return new ArrayBuffer(0);
    }

    const actualSize = Math.min(size, fullData.length - offset);
    const slice = fullData.subarray(offset, offset + actualSize);
    const copy = new Uint8Array(slice.length);
    copy.set(slice);
    return copy.buffer;
  }

  public getFetchLog(): Array<{ offset: number; size: number; timestamp: number }> {
    return [...this.fetchLog];
  }

  public reset(): void {
    this.streams.clear();
    this.fetchLog.length = 0;
    this.totalChunksFetched = 0;
  }
}

