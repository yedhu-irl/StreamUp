import assert from 'node:assert';
import { DownloadWindow, TELEGRAM_ALIGNMENT, DEFAULT_CHUNK_SIZE } from '../src/services/downloadWindow.ts';

console.log('Running DownloadWindow Windowing & Seek Matrix Tests...');

const fileSize = 100 * 1024 * 1024; // 100 MB test video file
const window = new DownloadWindow(fileSize);

// 1. Initial State
assert.strictEqual(window.downloadOffset, 0);
assert.strictEqual(window.downloadedPrefixSize, 0);
assert.strictEqual(window.contains(0), false);
assert.strictEqual(window.availableBytes(0), 0);

// 2. Alignment Check
assert.strictEqual(DownloadWindow.alignOffset(0), 0);
assert.strictEqual(DownloadWindow.alignOffset(4095), 0);
assert.strictEqual(DownloadWindow.alignOffset(4096), 4096);
assert.strictEqual(DownloadWindow.alignOffset(15000), 12288); // 3 * 4096

// 3. Populate Window at Byte 0
window.update(0, DEFAULT_CHUNK_SIZE); // 0 to 512KB
assert.strictEqual(window.contains(0), true);
assert.strictEqual(window.contains(512 * 1024 - 1), true);
assert.strictEqual(window.contains(512 * 1024), false);
assert.strictEqual(window.availableBytes(1024), 512 * 1024 - 1024);

// 4. Seek 10 Minutes into undownloaded range (e.g. byte 50,000,000)
const seekTarget = 50_000_000;
assert.strictEqual(window.contains(seekTarget), false);
assert.strictEqual(window.needsWindowMove(seekTarget, 1024), true);

const targetAlignedOffset = window.targetOffsetForPosition(seekTarget);
assert.strictEqual(targetAlignedOffset % TELEGRAM_ALIGNMENT, 0);
assert.strictEqual(targetAlignedOffset <= seekTarget, true);

// 5. Move Window to Seek Target
window.update(targetAlignedOffset, DEFAULT_CHUNK_SIZE);
assert.strictEqual(window.contains(seekTarget), true);
assert.strictEqual(window.needsWindowMove(seekTarget, 1024), false);

// 6. Rapid Seek Alternation (Target supersedes previous)
const rapidSeek1 = 20_000_000;
const rapidSeek2 = 80_000_000;
window.update(window.targetOffsetForPosition(rapidSeek1), DEFAULT_CHUNK_SIZE);
assert.strictEqual(window.contains(rapidSeek1), true);
window.update(window.targetOffsetForPosition(rapidSeek2), DEFAULT_CHUNK_SIZE);
assert.strictEqual(window.contains(rapidSeek2), true);
assert.strictEqual(window.contains(rapidSeek1), false); // superseded

// 7. MP4 Index at End of File Read (Tail read)
const tailOffset = window.targetOffsetForPosition(fileSize - 1024 * 1024);
assert.strictEqual(tailOffset % TELEGRAM_ALIGNMENT, 0);
assert.strictEqual(tailOffset < fileSize, true);

console.log('All DownloadWindow seek matrix arithmetic tests passed cleanly!');

