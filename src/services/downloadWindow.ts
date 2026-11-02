/**
 * DownloadWindow
 * 
 * Pure window arithmetic for offset-based partial downloads, matching TMPlayer's
 * core streaming logic from ARCHITECTURE.md.
 * 
 * Telegram MTProto strictly requires 4096-byte chunk offset alignment.
 * A window is valid for bytes [downloadOffset, downloadOffset + downloadedPrefixSize).
 */

export const TELEGRAM_ALIGNMENT = 4096;
export const DEFAULT_CHUNK_SIZE = 512 * 1024; // 512 KB
export const MAX_CHUNK_SIZE = 1024 * 1024; // 1 MB

export interface WindowRange {
  offset: number;
  size: number;
}

export class DownloadWindow {
  private _downloadOffset: number = 0;
  private _downloadedPrefixSize: number = 0;
  private _fileSize: number;

  constructor(fileSize: number) {
    this._fileSize = Math.max(0, fileSize);
  }

  get downloadOffset(): number {
    return this._downloadOffset;
  }

  get downloadedPrefixSize(): number {
    return this._downloadedPrefixSize;
  }

  get fileSize(): number {
    return this._fileSize;
  }

  get windowEnd(): number {
    return Math.min(this._fileSize, this._downloadOffset + this._downloadedPrefixSize);
  }

  /**
   * Align any byte offset downward to Telegram's 4096-byte boundary.
   */
  static alignOffset(offset: number): number {
    return Math.max(0, Math.floor(offset / TELEGRAM_ALIGNMENT) * TELEGRAM_ALIGNMENT);
  }

  /**
   * Align limit upward to Telegram's 4096-byte boundary, capped at MAX_CHUNK_SIZE.
   */
  static alignLimit(limit: number): number {
    const aligned = Math.ceil(limit / TELEGRAM_ALIGNMENT) * TELEGRAM_ALIGNMENT;
    return Math.min(MAX_CHUNK_SIZE, Math.max(TELEGRAM_ALIGNMENT, aligned));
  }

  /**
   * Check if a given byte position is already covered by the active window.
   */
  contains(position: number): boolean {
    return position >= this._downloadOffset && position < this.windowEnd;
  }

  /**
   * How many bytes can be read contiguously from `position` without moving the window.
   */
  availableBytes(position: number): number {
    if (!this.contains(position)) return 0;
    return Math.max(0, this.windowEnd - position);
  }

  /**
   * Check if reading `length` bytes at `position` requires moving the window.
   */
  needsWindowMove(position: number, length: number = 1): boolean {
    if (!this.contains(position)) return true;
    return this.availableBytes(position) < Math.min(length, 16384);
  }

  /**
   * Calculate the aligned Telegram offset needed to cover `targetPosition`.
   */
  targetOffsetForPosition(targetPosition: number): number {
    const clamped = Math.max(0, Math.min(targetPosition, this._fileSize - 1));
    return DownloadWindow.alignOffset(clamped);
  }

  /**
   * Update the active download window state with newly verified downloaded bytes.
   */
  update(offset: number, size: number) {
    this._downloadOffset = Math.max(0, offset);
    this._downloadedPrefixSize = Math.max(0, size);
  }

  /**
   * Extend the current prefix if the chunk is contiguous.
   */
  appendPrefix(bytesAdded: number) {
    this._downloadedPrefixSize = Math.min(
      this._fileSize - this._downloadOffset,
      this._downloadedPrefixSize + bytesAdded
    );
  }

  /**
   * Reset window state (e.g. on new file or full seek reload).
   */
  reset() {
    this._downloadOffset = 0;
    this._downloadedPrefixSize = 0;
  }
}

