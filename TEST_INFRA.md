# StreamUp Test Infrastructure & E2E Testing Philosophy

## 1. Testing Philosophy
The StreamUp E2E testing framework is designed around **opaque-box behavior verification**, treating the media streaming engine, Web Workers, transmuxers, and player UI as an integrated black-box system. Tests interact strictly through public interfaces, events, and observable browser state:
1. **Behavior Over Implementation Details**: Tests do not inspect internal private flags or hardcoded object shapes. Instead, tests observe public lifecycle events (`loadedmetadata`, `waiting`, `playing`, `canplay`, `error`), Media Source buffer allocations, and UI event callbacks (`onRetry`, `onClose`, `onPlayNext`).
2. **Authoritative Expected Outputs**: Every test derivation is grounded in formal media specifications (ISO/IEC 14496-12 ISO BMFF, RFC 8794 EBML, Matroska Specification v4, W3C Media Source Extensions) and project requirements documented in `ORIGINAL_REQUEST.md` and `PROJECT.md`.
3. **Hermetic & Independent Execution**: Each test suite runs in complete isolation with mock browser media primitives and in-memory MTProto simulation, eliminating flaky external network dependencies.
4. **Adversarial & Fault-Tolerant Verification**: Tests aggressively stress the pipeline with non-zero initial PTS gaps, audio lacing, quota limits, buffer evictions, abrupt network drops, and corrupted bitstreams.

---

## 2. Test Architecture & Directory Layout

```
d:\projects\sreamup\
├── tests\
│   ├── infra\
│   │   ├── test-harness.ts        # Vitest-compatible test framework (describe, it, expect, vi)
│   │   ├── mock-browser.ts        # Mock HTMLVideoElement, MediaSource, SourceBuffer, MockWorker
│   │   ├── synthetic-ebml.ts      # Bit-accurate Matroska / EBML generator (AVC, HEVC, AAC, AC-3)
│   │   ├── mock-telegram.ts       # MTProto chunk store and network latency / drop simulator
│   │   └── ts-loader.mjs          # Native ESM TypeScript and directory extension loader
│   ├── e2e\
│   │   ├── tier1-features.test.ts # Tier 1: Feature Coverage
│   │   ├── tier2-boundary.test.ts # Tier 2: Boundary & Corner Cases
│   │   ├── tier3-interactions.test.ts # Tier 3: Cross-Feature Interactions
│   │   ├── tier4-workloads.test.ts # Tier 4: Real-World Workload Scenarios
│   │   ├── playback-e2e.test.ts   # Comprehensive TV series playback & buffering track
│   │   └── error-ui-e2e.test.ts   # Comprehensive rich player error UI & recovery track
│   └── run-all.mjs                # Master test runner with colorized summary reporting
├── TEST_INFRA.md                  # Test architecture, philosophy & scenario specification
└── TEST_READY.md                  # Test suite readiness & execution verification
```

### Components:
- **`test-harness.ts`**: Provides complete Vitest API surface (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`) backed by Node.js native testing and assertion engine.
- **`mock-browser.ts`**: Implements high-fidelity W3C Media Source Extensions, `HTMLVideoElement` state machine (`HAVE_NOTHING` to `HAVE_ENOUGH_DATA`), `TimeRanges`, and Web Worker IPC.
- **`synthetic-ebml.ts`**: Generates real binary Matroska containers (EBML Header, Info, Tracks, Clusters, SimpleBlocks) with parameterized audio/video codecs, laced frames, and timestamp offsets.
- **`mock-telegram.ts`**: Emulates Telegram cloud streaming, chunk retrieval (512KB chunks), flood waits, socket timeouts, and network stalls.
- **`ts-loader.mjs`**: Enables Node 24 native TypeScript execution without transpilation overhead.

---

## 3. Feature Inventory & Mapping

| Feature # | Feature Name | Target Requirement | Covered In |
|:---:|---|:---:|---|
| **F1** | TV Series Container & Routing | R1 | `tier1-features.test.ts`, `tier3-interactions.test.ts`, `playback-e2e.test.ts` |
| **F2** | Stream Worker Chunk 0 Offset Monotonicity | R1 | `tier1-features.test.ts`, `tier4-workloads.test.ts`, `playback-e2e.test.ts` |
| **F3** | AC-3 Audio Deadlock Prevention | R1 | `tier2-boundary.test.ts`, `playback-e2e.test.ts` |
| **F4** | Matroska Multi-Frame Audio Lacing | R1 | `tier2-boundary.test.ts`, `playback-e2e.test.ts` |
| **F5** | Initial Non-Zero PTS Gap Bridging | R1 | `tier2-boundary.test.ts`, `playback-e2e.test.ts` |
| **F6** | Pipelined Concurrent Chunk Prefetching | R2 | `tier4-workloads.test.ts`, `playback-e2e.test.ts` |
| **F7** | Dynamic Buffer Window & Watermarks | R2 | `tier4-workloads.test.ts`, `playback-e2e.test.ts` |
| **F8** | Symmetric SourceBuffer Eviction | R2 | `tier2-boundary.test.ts`, `tier4-workloads.test.ts` |
| **F9** | Segment Append Cadence & Queue Flushing | R2 | `tier1-features.test.ts`, `tier4-workloads.test.ts` |
| **F10** | Buffering Stall & Micro-gap Recovery | R2 | `tier3-interactions.test.ts`, `playback-e2e.test.ts` |
| **F11** | Rich Player Error Overlay Layout | R3 | `tier1-features.test.ts`, `error-ui-e2e.test.ts` |
| **F12** | Human-Readable Error Translation | R3 | `tier1-features.test.ts`, `error-ui-e2e.test.ts` |
| **F13** | Interactive Retry & Navigation Controls | R3 | `tier1-features.test.ts`, `tier3-interactions.test.ts`, `error-ui-e2e.test.ts` |
| **F14** | Video Decode Error Interception | R3 | `tier4-workloads.test.ts`, `error-ui-e2e.test.ts` |

---

## 4. 4-Tier Test Scenarios

### Tier 1: Feature Coverage (Opaque-Box Happy Path)
- **TC 1.1**: TV Series Episode Loading — Detects `.mkv` container, parses EBML header, extracts video and audio tracks.
- **TC 1.2**: Transmuxer Init Segment — Generates ISO BMFF fragmented MP4 `ftyp` and `moov` init segment.
- **TC 1.3**: MSE Append Flow — Instantiates `SourceBuffer` and executes asynchronous `appendBuffer` without `updating` collision.
- **TC 1.4**: Error Data Model — Verifies `PlayerErrorDetails` structure and codes.
- **TC 1.5**: Interactive Retry Action — Verifies `onRetry` callback receives file/stream ID.
- **TC 1.6**: Interactive Back Navigation — Verifies `onClose` callback returns to catalog.

### Tier 2: Boundary & Corner Cases
- **TC 2.1**: Non-Zero Initial PTS Gap — Handles media files where first cluster timestamp starts at >0ms (e.g. 80ms) without causing NaN duration or playback freeze.
- **TC 2.2**: Matroska Audio Lacing — Parses Xiph/EBML laced SimpleBlocks with multiple audio frames.
- **TC 2.3**: AC-3 Audio Deadlock Prevention — Ensures transmuxer does not emit empty audio segments for non-AAC tracks, preventing orphaned audio `SourceBuffer` freeze at `HAVE_METADATA`.
- **TC 2.4**: Quota Exhaustion & Symmetric Eviction — Simulates browser `QuotaExceededError` when memory ceiling is reached, followed by buffer eviction.
- **TC 2.5**: Empty Metadata Fallbacks — Validates visual fallback cascade (Apple TV dark gradient, parsed filename title) when TMDB poster and backdrop are null.
- **TC 2.6**: Network Drops & Timeouts — Emulates MTProto timeout and verifies rejection with actionable error message.

### Tier 3: Cross-Feature Interactions
- **TC 3.1**: Buffering State Transition & Recovery — Verifies player transitions to `isBuffering = true` on `waiting` event and recovers to `false` upon receiving data (`playing`/`canplay`).
- **TC 3.2**: Mid-Stream Error Retry — Preserves interrupted timestamp `currentTime` and re-initializes engine with resume position.
- **TC 3.3**: Episode Switching Lifecycle — Cleanly tears down failed stream engine and instantiates next episode without leaking workers or event listeners.
- **TC 3.4**: TV Series Item Routing — Ensures series cards route to MSE remuxer rather than failing on Native MP4 demuxer.

### Tier 4: Real-World Workload Scenarios
- **TC 4.1**: Continuous Multi-Chunk Prefetching — Simulates sustained sequential downloading across 12+ 512KB chunks (~6MB) with monotonic offset verification.
- **TC 4.2**: Rapid Seek Stress — Rapidly fires seek requests across multiple playhead locations, verifying obsolete requests are aborted and buffers flushed.
- **TC 4.3**: Corrupted Bitstream Decode Fault Interception — Feeds malformed bitstream to video element, intercepts `MEDIA_ERR_DECODE`, and surfaces recoverable error UI.
- **TC 4.4**: Long Playback Memory Pressure — Sustained playback with 25+ segment appends confirms memory footprint remains strictly bounded below quota.

---

## 5. Execution & Verification

### Running the Full Test Suite:
```bash
npm test
```
or directly via Node 24:
```bash
node tests/run-all.mjs
```

### Running Individual Test Suites:
```bash
node --test --experimental-strip-types --loader ./tests/infra/ts-loader.mjs tests/e2e/playback-e2e.test.ts
node --test --experimental-strip-types --loader ./tests/infra/ts-loader.mjs tests/e2e/error-ui-e2e.test.ts
```

### Coverage Thresholds:
- **Suite Pass Rate**: 100% (35 / 35 tests passing)
- **Feature Coverage**: 100% of Requirements R1, R2, and R3
- **Test Execution Time**: < 12 seconds across all 6 suites

