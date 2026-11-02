# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

React 18, Vite, TypeScript, Tailwind CSS, GramJS (MTProto over WSS), Dexie.js (IndexedDB)

## Users

Individuals and media enthusiasts who store or follow movies and TV series in Telegram channels and want a premium, Netflix/Apple TV-grade streaming interface on their Web browser and LG webOS Smart TV without hosting a private media server (no Plex, Jellyfin, or VPS required).

## Product Purpose

Transform any Telegram video channel into an instant, high-definition personal streaming service. Eliminate server costs and complex media server maintenance by streaming directly from Telegram data centers to the client via MTProto and browser Service Worker range requests, enriched with TMDB posters, cast, synopsis, and season/episode hierarchy.

## Positioning

The first 100% serverless, zero-backend Telegram streaming client with native Smart TV remote support. Unlike bot-based web streamers that rely on proxy servers or download whole files into memory, this platform turns the browser/TV itself into a direct MTProto client with on-demand chunk streaming.

## Operating Context

- **Smart TV (LG webOS)**: 10-foot viewing distance, controlled entirely via D-pad remote (`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Enter`, `Back`).
- **Desktop & Laptop Web**: Controlled via mouse, trackpad, and keyboard shortcuts (`Space` to pause, `F` for fullscreen, arrow keys to seek).
- **Mobile Web**: Touch-first responsive drawer layout.

## Capabilities and Constraints

- **Telegram Auth**: Direct client-side MTProto authentication via QR Code or Phone + OTP, requiring user `api_id` and `api_hash`.
- **Channel Import**: Select joined channels or groups to act as custom streaming categories (e.g. "Malayalam Movies", "English Series").
- **Metadata Engine**: Smart filename parser extracts Title, Year, Season, Episode, Resolution, and Codecs; fetches TMDB posters, backdrops, ratings, and cast.
- **TV Series Grouping**: Groups related files into Show -> Season -> Episode hierarchy with thumbnails and episode descriptions.
- **Zero-Lag Streamer**: Service Worker translates HTTP 206 Range requests into parallel Telegram chunk queries with an 8–16MB ring buffer to eliminate buffering.
- **Player Suite**: Custom cinematic player with audio track selector, embedded + channel `.srt` subtitle parser, playback speed, and auto-play next episode countdown.
- **Persistence**: IndexedDB stores user session, channel cache, watch progress, and "My List" bookmarks.
- **Global Search**: Search by title, actor, director, or genre across all imported channels.
- **Constraint**: Pure client-side MTProto requires WebSockets (`wss://`); video playback relies on browser/TV hardware decoding capabilities.

## Brand Commitments

- **Aesthetic Direction**: Apple TV+ inspired minimalist luxury.
- **Color Palette**: Deep OLED blacks (`#08090a`, `#0e1115`), obsidian card surfaces with razor-thin borders (`border-white/10`), crisp white typography, and subtle metallic or gold/amber accents.
- **Anti-AI-Slop Pledge**: No generic purple/cyan gradient glow, no cluttered floating cards, no robotic stock iconography. Strict focus on typography hierarchy, photographic posters, and subtle frosted glass (`backdrop-blur-md bg-black/40`).

## Evidence on Hand

- Standard Telegram video message payloads (`InputMessagesFilterDocument`, `DocumentAttributeVideo`, `DocumentAttributeFilename`).
- TMDB API v3 endpoints for movie/tv queries, credits, and poster assets.
- Web standard Service Worker `fetch` interceptor with `ReadableStream` response.

## Product Principles

1. **Zero Server Dependency**: 100% of data and media flow directly between Telegram and the user's device.
2. **Buffer-Free Playback**: High-bitrate video must start instantly and seek without stutter via predictive chunk pre-fetching.
3. **Flawless 10-Foot Usability**: Every screen element must be effortlessly reachable and visibly focused via TV remote D-pad.
4. **Cinematic Immersion**: Interface recedes during media consumption; typography, fanart, and metadata take center stage.

## Accessibility & Inclusion

- High-contrast visual focus rings (minimum 3:1 contrast against dark background) for TV remote navigation.
- Full keyboard parity for all mouse actions.
- Customizable subtitle sizing and contrast backdrop.

