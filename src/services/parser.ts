import type { ParsedMediaInfo } from '../types';

export function parseMediaFileName(filename: string): ParsedMediaInfo {
  // Strip extension
  const baseName = filename.replace(/\.[a-zA-Z0-9]{2,4}$/, '');
  let clean = baseName;

  // 1. Identify and extract resolution first so it NEVER collides with SxxExx or WxH
  let resolution: string | undefined;
  if (/\b(2160p|4k|uhd)\b/i.test(clean)) resolution = '4K';
  else if (/\b(1080p|fhd)\b/i.test(clean)) resolution = '1080p';
  else if (/\b(720p|hd)\b/i.test(clean)) resolution = '720p';
  else if (/\b(480p|sd)\b/i.test(clean)) resolution = '480p';

  // 2. Strict Series Matching:
  // Must be S01E02, S1E2, Season 1 Episode 2, S01 - E02 with word boundaries
  // Explicitly ignore resolution dimensions like 1920x1080 or 1280x720!
  let season: number | undefined;
  let episode: number | undefined;
  let isSeries = false;

  // Standard S01E02 or S1E03
  const sxxExxMatch = clean.match(/\b(?:s|season)[.\s_-]?(\d{1,2})[.\s_-]?(?:e|ep|episode)[.\s_-]?(\d{1,3})\b/i);

  // Full words: Season 1 Episode 2
  const seasonEpWordsMatch = clean.match(/\bseason\s*(\d{1,2})\s*[-–._\s]?\s*episode\s*(\d{1,3})\b/i);

  // Strict 1x02 or 01x02 (isolated by boundary and NOT preceded by digits, e.g. NOT 1920x1080)
  const xMatch = clean.match(/(?<!\d)\b(\d{1,2})x(\d{2,3})\b(?!\d)/i);

  // Standalone episode: Ep 01, Episode 1, E01
  const epOnlyMatch = clean.match(/\b(?:episode|ep)[.\s_-]?(\d{1,3})\b/i) || clean.match(/(?<![a-zA-Z0-9])e(\d{1,3})\b/i);

  if (sxxExxMatch) {
    season = parseInt(sxxExxMatch[1], 10);
    episode = parseInt(sxxExxMatch[2], 10);
    isSeries = true;
  } else if (seasonEpWordsMatch) {
    season = parseInt(seasonEpWordsMatch[1], 10);
    episode = parseInt(seasonEpWordsMatch[2], 10);
    isSeries = true;
  } else if (xMatch) {
    season = parseInt(xMatch[1], 10);
    episode = parseInt(xMatch[2], 10);
    isSeries = true;
  } else if (epOnlyMatch) {
    season = 1;
    episode = parseInt(epOnlyMatch[1], 10);
    isSeries = true;
  }

  // 3. Extract Year (1920 - 2035) with word boundaries
  let year: number | undefined;
  const yearMatch = clean.match(/\b([12]\d{3})\b/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y >= 1930 && y <= 2030) {
      year = y;
    }
  }

  // 4. Extract Codec
  let codec: string | undefined;
  if (/\b(hevc|h[.\s_-]?265|x265)\b/i.test(clean)) codec = 'HEVC';
  else if (/\b(avc|h[.\s_-]?264|x264)\b/i.test(clean)) codec = 'x264';
  else if (/\b(av1)\b/i.test(clean)) codec = 'AV1';

  // 5. Extract Quality
  let quality: string | undefined;
  if (/\b(bluray|bdrip)\b/i.test(clean)) quality = 'BluRay';
  else if (/\b(web-?dl|webrip)\b/i.test(clean)) quality = 'WEB-DL';
  else if (/\b(hdrip)\b/i.test(clean)) quality = 'HDRip';
  else if (/\b(dvdrip)\b/i.test(clean)) quality = 'DVDRip';
  if (/\b(hdr(?:10)?(?:\+)?)\b/i.test(clean)) quality = quality ? `${quality} HDR` : 'HDR';

  // 6. Clean Title extraction: cut off everything after year or season/episode
  let title = clean;

  if (sxxExxMatch && sxxExxMatch.index !== undefined) {
    title = title.substring(0, sxxExxMatch.index);
  } else if (seasonEpWordsMatch && seasonEpWordsMatch.index !== undefined) {
    title = title.substring(0, seasonEpWordsMatch.index);
  } else if (xMatch && xMatch.index !== undefined) {
    title = title.substring(0, xMatch.index);
  } else if (epOnlyMatch && epOnlyMatch.index !== undefined) {
    title = title.substring(0, epOnlyMatch.index);
  } else if (yearMatch && yearMatch.index !== undefined) {
    title = title.substring(0, yearMatch.index);
  }

  // Remove bracketed info [PSA], (1080p), etc.
  title = title.replace(/\[.*?\]|\(.*?\)/g, ' ');

  // Remove technical keywords and regional tags
  const junkRegex = /\b(1080p|720p|2160p|4k|bluray|web-?dl|webrip|hdrip|dvdrip|x264|x265|hevc|h264|h265|aac|ac3|dts|eac3|remux|repack|proper|unrated|extended|dual[.\s_-]audio|multi[.\s_-]audio|malayalam|tamil|hindi|english|telugu|kannada|esub|org)\b/gi;
  title = title.replace(junkRegex, ' ');

  // Remove dimensions (1920x1080 etc)
  title = title.replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ');

  // Replace dots, underscores, dashes with spaces
  title = title.replace(/[._\-]+/g, ' ').trim();
  title = title.replace(/\s{2,}/g, ' ');

  if (!title) {
    title = baseName;
  }

  return {
    cleanTitle: title,
    year,
    season,
    episode,
    resolution,
    codec,
    quality,
    isSeries,
    originalFileName: filename,
  };
}
