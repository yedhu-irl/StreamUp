/**
 * tests/infra/mock-browser.ts
 * High-fidelity Mock Browser Environment for MSE, HTML5 Video, and Web Workers.
 */

export class MockTimeRanges implements TimeRanges {
  private ranges: Array<{ start: number; end: number }> = [];

  constructor(ranges?: Array<{ start: number; end: number }>) {
    if (ranges) this.ranges = [...ranges];
  }

  get length(): number {
    return this.ranges.length;
  }

  start(index: number): number {
    if (index >= this.ranges.length || index < 0) {
      throw new DOMException('Index out of bounds', 'IndexSizeError');
    }
    return this.ranges[index].start;
  }

  end(index: number): number {
    if (index >= this.ranges.length || index < 0) {
      throw new DOMException('Index out of bounds', 'IndexSizeError');
    }
    return this.ranges[index].end;
  }

  addRange(start: number, end: number): void {
    this.ranges.push({ start, end });
    this.ranges.sort((a, b) => a.start - b.start);
  }

  remove(start: number, end: number): void {
    const updated: Array<{ start: number; end: number }> = [];
    for (const r of this.ranges) {
      if (end <= r.start || start >= r.end) {
        updated.push(r);
      } else {
        if (r.start < start) updated.push({ start: r.start, end: start });
        if (r.end > end) updated.push({ start: end, end: r.end });
      }
    }
    this.ranges = updated;
  }
}

export class MockSourceBuffer extends EventTarget {
  public updating = false;
  public buffered: MockTimeRanges = new MockTimeRanges();
  public mode: 'segments' | 'sequence' = 'segments';
  public timestampOffset = 0;
  public mimeType: string;
  public appendHistory: ArrayBuffer[] = [];
  public quotaLimitBytes: number = 50 * 1024 * 1024; // 50MB default quota
  public currentBytes = 0;
  public simulateQuotaError = false;

  constructor(mimeType: string) {
    super();
    this.mimeType = mimeType;
  }

  appendBuffer(data: ArrayBuffer | ArrayBufferView): void {
    if (this.updating) {
      throw new DOMException('Cannot appendBuffer while updating', 'InvalidStateError');
    }

    const byteLen = data.byteLength;
    if (this.simulateQuotaError || (this.currentBytes + byteLen > this.quotaLimitBytes)) {
      const err = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      this.dispatchEvent(new Event('error'));
      throw err;
    }

    this.updating = true;
    this.dispatchEvent(new Event('updatestart'));

    const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.appendHistory.push(buf as ArrayBuffer);
    this.currentBytes += byteLen;

    // Simulate async updateend
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('update'));
      this.dispatchEvent(new Event('updateend'));
    }, 5);
  }

  remove(start: number, end: number): void {
    if (this.updating) {
      throw new DOMException('Cannot remove while updating', 'InvalidStateError');
    }
    this.updating = true;
    this.dispatchEvent(new Event('updatestart'));

    this.buffered.remove(start, end);

    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('update'));
      this.dispatchEvent(new Event('updateend'));
    }, 5);
  }

  abort(): void {
    this.updating = false;
    this.dispatchEvent(new Event('abort'));
  }
}

export class MockMediaSource extends EventTarget {
  public static supportedTypes: Set<string> = new Set([
    'video/mp4; codecs="avc1.640028"',
    'video/mp4; codecs="avc1.4d401f"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'audio/mp4; codecs="mp4a.40.2"',
    // AC-3 passthrough support flag
    'audio/mp4; codecs="ac-3"',
    'audio/mp4; codecs="ec-3"',
  ]);

  public static isTypeSupported(mimeType: string): boolean {
    return MockMediaSource.supportedTypes.has(mimeType);
  }

  public readyState: 'closed' | 'open' | 'ended' = 'open';
  public duration = 0;
  public sourceBuffers: MockSourceBuffer[] = [];
  public activeSourceBuffers: MockSourceBuffer[] = [];

  addSourceBuffer(mimeType: string): MockSourceBuffer {
    if (this.readyState !== 'open') {
      throw new DOMException('MediaSource is not open', 'InvalidStateError');
    }
    const sb = new MockSourceBuffer(mimeType);
    this.sourceBuffers.push(sb);
    this.activeSourceBuffers.push(sb);
    return sb;
  }

  removeSourceBuffer(sb: MockSourceBuffer): void {
    const idx = this.sourceBuffers.indexOf(sb);
    if (idx !== -1) this.sourceBuffers.splice(idx, 1);
    const actIdx = this.activeSourceBuffers.indexOf(sb);
    if (actIdx !== -1) this.activeSourceBuffers.splice(actIdx, 1);
  }

  endOfStream(_error?: string): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('sourceended'));
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('sourceclose'));
  }
}

export class MockHTMLVideoElement extends EventTarget {
  public src = '';
  public currentTime = 0;
  public duration = 0;
  public readyState = 0; // 0=HAVE_NOTHING, 1=HAVE_METADATA, 2=HAVE_CURRENT_DATA, 3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA
  public paused = true;
  public error: { code: number; message: string } | null = null;
  public buffered: MockTimeRanges = new MockTimeRanges();
  public networkState = 0;

  load(): void {
    this.networkState = 1; // NETWORK_LOADING
  }

  async play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  simulateMetadataLoaded(durationSec: number): void {
    this.duration = durationSec;
    this.readyState = 1; // HAVE_METADATA
    this.dispatchEvent(new Event('loadedmetadata'));
  }

  simulateCanPlay(): void {
    this.readyState = 3; // HAVE_FUTURE_DATA
    this.dispatchEvent(new Event('canplay'));
  }

  simulateError(code: number, message: string): void {
    this.error = { code, message };
    this.dispatchEvent(new Event('error'));
  }

  simulateWaiting(): void {
    this.dispatchEvent(new Event('waiting'));
  }

  simulateStalled(): void {
    this.dispatchEvent(new Event('stalled'));
  }

  simulateTimeUpdate(time: number): void {
    this.currentTime = time;
    this.dispatchEvent(new Event('timeupdate'));
  }
}

export class MockWorker extends EventTarget {
  public onmessage: ((event: { data: any }) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public messageHistory: any[] = [];
  public isTerminated = false;

  constructor(_scriptUrl?: string | URL, _options?: any) {
    super();
  }

  public postMessage(data: any): void {
    if (this.isTerminated) return;
    this.messageHistory.push(data);
  }

  public simulateWorkerMessage(data: any): void {
    if (this.isTerminated) return;
    const evt = { data };
    if (this.onmessage) this.onmessage(evt);
    this.dispatchEvent(new Event('message'));
  }

  public terminate(): void {
    this.isTerminated = true;
  }
}

/**
 * Global Browser Test Environment Injector
 */
export function setupMockBrowserEnvironment() {
  const originalGlobals: Record<string, any> = {};

  const g = globalThis as any;
  originalGlobals.window = g.window;
  originalGlobals.MediaSource = g.MediaSource;
  originalGlobals.HTMLVideoElement = g.HTMLVideoElement;
  originalGlobals.URL = g.URL;
  originalGlobals.document = g.document;
  originalGlobals.Worker = g.Worker;

  g.window = g;
  g.MediaSource = MockMediaSource;
  g.HTMLVideoElement = MockHTMLVideoElement;
  g.Worker = MockWorker;

  const objectUrls = new Map<string, any>();
  let urlCounter = 1;

  g.URL = {
    ...g.URL,
    createObjectURL: (obj: any) => {
      const url = `blob:http://localhost/${urlCounter++}`;
      objectUrls.set(url, obj);
      // If obj is MediaSource, trigger sourceopen shortly
      if (obj instanceof MockMediaSource) {
        setTimeout(() => obj.open(), 0);
      }
      return url;
    },
    revokeObjectURL: (url: string) => {
      objectUrls.delete(url);
    },
  };

  g.document = {
    createElement: (tag: string) => {
      if (tag === 'video') return new MockHTMLVideoElement();
      return new EventTarget();
    },
  };

  return {
    cleanup: () => {
      g.window = originalGlobals.window;
      g.MediaSource = originalGlobals.MediaSource;
      g.HTMLVideoElement = originalGlobals.HTMLVideoElement;
      g.URL = originalGlobals.URL;
      g.document = originalGlobals.document;
      g.Worker = originalGlobals.Worker;
    },
  };
}
