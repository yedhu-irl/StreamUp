# Project: StreamUp Playback Stabilization & Rich Error UI

## Architecture
StreamUp is a React + TypeScript media streaming platform running in browser/TV web environments.
The playback subsystem consists of:
- **UI Layer (`src/features/player/`, `src/components/`, `src/App.tsx`)**: `TMWebPlayer`, video controls, media metadata presentation, and player error overlays.
- **Player Session Hook (`src/features/player/hooks/usePlayerSession.ts`)**: Coordinates playback lifecycle, playhead watchdogs, state machine (`IDLE`, `LOADING`, `PLAYING`, `BUFFERING`, `ERROR`), and user actions.
- **Engine Layer (`src/services/playerEngine.ts`)**: Decides playback routing (direct HTML5 `<video src>` vs MSE streaming pipeline) based on format/codecs.
- **Streaming & MSE Pipeline (`src/services/mseController.ts`, `src/services/remuxer/`)**: Manages `MediaSource`, `SourceBuffer`s (video and audio), transmuxing from Matroska/EBML to fMP4 (ISO BMFF), timestamp synchronization, and buffer eviction.
- **Stream Worker (`src/workers/streamWorker.ts`)**: Web Worker handling HTTP Range requests, chunk downloading, caching, EBML cluster demuxing, and fMP4 packaging off the main UI thread.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | TV Series Filename & Routing | Preserve `.mkv` extension and container detection on TV series episode cards in App.tsx / playerEngine so TV episodes route to MSE pipeline | M1_TV_PIPELINE | ORIGINAL_REQUEST R1, Survey 1 |
| 2 | Worker Chunk 0 Offset Fix | Fix `currentReadOffset` calculation in `streamWorker.ts` so Chunk 0 is not re-fetched and duplicate bytes are not appended to clusterAccumulator | M1_TV_PIPELINE | ORIGINAL_REQUEST R1, Survey 1 |
| 3 | AC-3 Audio Deadlock Resolution | Prevent creation of orphaned audio SourceBuffer when audio codec (e.g. AC-3) produces 0 fMP4 segments in transmuxer, preventing HAVE_METADATA freeze | M1_TV_PIPELINE | ORIGINAL_REQUEST R1, Survey 1, Survey 2 |
| 4 | Matroska Audio Lacing Support | Parse Xiph/EBML lacing in `ebml.ts` so multi-frame audio blocks decode correctly | M1_TV_PIPELINE | ORIGINAL_REQUEST R1, Survey 1 |
| 5 | Initial PTS Gap & Ready Signal | Ensure player bridges initial non-zero PTS offset (>0s) and only marks player ready when initial media segments are buffered | M1_TV_PIPELINE | ORIGINAL_REQUEST R1, Survey 1 |
| 6 | Pipelined Chunk Prefetching | Implement pipelined lookahead prefetching in `streamWorker.ts` to overcome network RTT latency and eliminate chunk starvation | M2_BUFFER_OPTIMIZATION | ORIGINAL_REQUEST R2, Survey 2 |
| 7 | Dynamic Buffer Window & Watermarks | Implement low-watermark burst prefetching (<10s) and elastic buffer window (up to 45-60s) with hysteresis | M2_BUFFER_OPTIMIZATION | ORIGINAL_REQUEST R2, Survey 2 |
| 8 | Symmetric Buffer Eviction | Evict both audio and video SourceBuffers behind the playhead to eliminate QuotaExceededError crashes during long playback | M2_BUFFER_OPTIMIZATION | ORIGINAL_REQUEST R2, Survey 2 |
| 9 | Segment Append Cadence | Optimize segment emission cadence from worker to reduce SourceBuffer `updating` contention | M2_BUFFER_OPTIMIZATION | ORIGINAL_REQUEST R2, Survey 2 |
| 10 | Micro-gap Jumper & Stall Watchdog | Automatically jump over sub-frame buffer gaps (<0.1s) and recover from buffering stalls | M2_BUFFER_OPTIMIZATION | ORIGINAL_REQUEST R2, Survey 2 |
| 11 | Rich Player Error Overlay Component | Visually rich error state UI displaying backdrop banner, poster, show/movie title, episode info, and frosted fallbacks | M3_ERROR_UI | ORIGINAL_REQUEST R3, Survey 3 |
| 12 | Human-Readable Error Translation | Translate raw MSE/network/DOM errors into clear, actionable explanations with collapsible technical details | M3_ERROR_UI | ORIGINAL_REQUEST R3, Survey 3 |
| 13 | Interactive Retry & Navigation Controls | Functional "Retry" (re-initializes stream at current or start position) and "Back" / "Play Another" (navigates away) with D-Pad/remote focus | M3_ERROR_UI | ORIGINAL_REQUEST R3, Survey 3 |
| 14 | Error Event Plumbing & Interception | Attach HTMLVideoElement error listeners in MSE mode, catch unhandled MSE errors, and trigger error state instead of silent black screen | M3_ERROR_UI | ORIGINAL_REQUEST R3, Survey 3 |
| 15 | Opaque-Box E2E Test Suite | Comprehensive 4-tier test suite verifying TV playback, buffering elimination, error UI display, retry, and navigation | M_E2E_TESTS | ORIGINAL_REQUEST Verification |
| 16 | Final Integration & Adversarial Hardening | 100% E2E test pass followed by Tier 5 adversarial stress testing | M_FINAL_VERIFICATION | Project Pattern Dual Track |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | M1_TV_PIPELINE | TV Series stream routing, Chunk 0 re-fetch fix, AC-3 audio deadlock elimination, Matroska audio lacing, initial PTS gap bridge | none | DONE |
| M2 | M2_BUFFER_OPTIMIZATION | Pipelined chunk prefetching, dynamic buffer window/watermarks, symmetric audio+video buffer eviction, segment batching, stall recovery | M1 | DONE |
| M3 | M3_ERROR_UI | Rich Player Error State UI component, metadata display with fallbacks, human-readable error formatting, Retry & Back controls, video error interception | none (can develop alongside M1/M2) | DONE |
| ME | M_E2E_TESTS | Opaque-box E2E testing track: test harness, Tiers 1-4 test cases, publish TEST_READY.md | none (runs in parallel) | DONE |
| MF | M_FINAL_VERIFICATION | Phase 1: 100% pass of E2E tests; Phase 2: Tier 5 adversarial stress testing | M1, M2, M3, ME | DONE |

## Interface Contracts

### M1_TV_PIPELINE ↔ M2_BUFFER_OPTIMIZATION
- `streamWorker.ts`:
  - `currentReadOffset`: must track monotonically; header scan limits respected.
  - `postMessage({ type: 'DATA_SEGMENT', mediaType: 'video'|'audio', data, timestamp, duration })`: segments must have valid sequential PTS and duration.
- `mseController.ts`:
  - `hasAudioTrack()`: true only if transmuxer emits audio fMP4 segments for the track codec.
  - `appendBuffer()`: handles queuing while `updating` is true.

### M3_ERROR_UI ↔ Player Pipeline
- `PlayerErrorState`:
  ```typescript
  interface PlayerErrorDetails {
    code: 'NETWORK_TIMEOUT' | 'MEDIA_DECODE_ERROR' | 'UNSUPPORTED_FORMAT' | 'BUFFER_EXHAUSTED' | 'STREAM_STALL' | 'UNKNOWN';
    title: string;
    message: string;
    technicalDetails?: string;
    recoverable: boolean;
  }
  ```
- Props to `PlayerErrorOverlay`:
  - `media: ChannelVideoItem`: TMDB poster, backdrop, title, season/episode tags.
  - `error: PlayerErrorDetails`: parsed user-facing error details.
  - `onRetry: () => void`: restarts playback session.
  - `onClose: () => void`: navigates back to previous screen.
  - `onPlayNext?: () => void`: optional next episode action.

## Code Layout
- UI Components: `src/features/player/components/`
  - `PlayerErrorOverlay.tsx`
  - `TMWebPlayer.tsx`
- Hooks & Session: `src/features/player/hooks/`
  - `usePlayerSession.ts`
- Player Engine & Routing: `src/services/`
  - `playerEngine.ts`
  - `mseController.ts`
- Transmuxing & EBML: `src/services/remuxer/`
  - `transmuxer.ts`
  - `ebml.ts`
  - `mp4Generator.ts`
- Streaming Web Worker: `src/workers/`
  - `streamWorker.ts`
- Tests: `tests/`
  - `tests/e2e/`
  - `tests/unit/`
