# Design System: Apple TV (tvOS)

<!-- impeccable:design-schema 1 -->

## World

Apple TV (tvOS) Cinema Experience: Pure pitch black OLED canvas (`#000000`), smoky frosted glass materials (`backdrop-blur-3xl bg-black/60` and `bg-[#121214]/90`), razor-thin top-lit border highlights (`border-white/15`), Apple TV segmented pill navigation, and pearlescent white focus states. Strictly follows Apple's fluid interface principles from WWDC (instant pointer-down feedback, interruptible transitions, optical sizing, and spatial consistency).

## Palette

- **Ground**: `#000000` (True pitch black for OLED TV power efficiency and total cinematic immersion)
- **Surfaces**:
  - `#08080a` (Surface 950 — background deep canvas)
  - `#121214` (Surface 900 — sheets, cards, and floating panels)
  - `#1a1a1e` (Surface 850 — active surfaces and hover states)
- **Borders & Materials**:
  - `rgba(255, 255, 255, 0.12)` (Hairline frosted border)
  - `border-t border-white/20` (Apple specular top-lit rim highlight)
  - `backdrop-blur-3xl bg-black/60` (Apple HUD and pinned header material)
- **Accents**:
  - `#ffffff` (Primary text, active pill tabs, transport highlights, focus rings)
  - `rgba(255, 255, 255, 0.70)` (Secondary metadata, durations, and labels)
  - `#f59e0b` / `#fbbf24` (Cinema rating stars)
  - `#34d399` (MTProto connection active emerald)

## Typography

- **Display Headings**: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Outfit", Inter, sans-serif` (Bold/Semibold, optical negative tracking `-0.02em` to `-0.03em`)
- **Body & UI**: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif` (400/500/600 weight, comfortable leading)
- **Monospace & Timestamps**: `ui-monospace, "SF Mono", monospace` (Timestamps, speed rates, codes)

## Motion & Spatial Interaction

- **Focus System**: High-contrast pearlescent focus ring (`ring-4 ring-white shadow-[0_0_25px_rgba(255,255,255,0.3)] scale-[1.04]`) for 10-ft TV remote D-pad navigation.
- **Micro-Interactions**: Direct instant response on pointer-down (`active:scale-95` / `active:scale-97`), smooth 60fps spring transitions.
- **Ambient Wash**: Multi-stop gradient masks blend panoramic fanart into pure black at the bottom and sides.

## Component Hierarchy

1. **Header**: Apple TV floating translucent pill header (`backdrop-blur-3xl bg-black/60 border-b border-white/10`) with brand typography, segmented navigation capsule, search, TV remote toggle, and settings.
2. **Hero Spotlight**: 78vh panoramic fanart billboard with multi-stop linear gradient masking, Apple TV metadata badges (`4K`, `HDR`, `Dolby Atmos`, `CC`), clean synopsis, and primary solid white "Play" pill.
3. **Continue Watching**: 16:9 aspect ratio landscape cards with clean white progress bars and remaining time calculation (`24m left`).
4. **Media Shelf Rows**: 2:3 aspect ratio portrait cards with rounded-2xl corners, top-right rating badges, bottom title overlay, and spring scale on hover/focus.
5. **Series Browser**: TV series modal with Season pill selectors and episode list cards.
6. **Apple TV Player**: Fullscreen media player with floating frosted-glass HUD pod, dual time layout (elapsed on left, remaining on right with minus `-`), precision scrubber with buffer bar, 10s skip controls, embedded and channel `.srt` subtitle switcher, audio track switcher, playback speed options, real-time speed monitor, and auto-play next episode countdown.
