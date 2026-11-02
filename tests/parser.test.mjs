import assert from 'node:assert';
import { parseMediaFileName } from '../src/services/parser.ts';

console.log('Running Strict Filename Parser Tests...');

// 1. Movie with resolution, codec, year, release tags
const movie1 = parseMediaFileName('Interstellar.2014.1080p.WEB-DL.x264.Pahe.mp4');
assert.strictEqual(movie1.cleanTitle, 'Interstellar');
assert.strictEqual(movie1.year, 2014);
assert.strictEqual(movie1.resolution, '1080p');
assert.strictEqual(movie1.codec, 'x264');
assert.strictEqual(movie1.isSeries, false);

// 2. Movie with 1920x1080 in name - MUST NOT be treated as series
const movieDimension = parseMediaFileName('Aavesham.2024.Malayalam.1920x1080.HDRip.mkv');
assert.strictEqual(movieDimension.cleanTitle, 'Aavesham');
assert.strictEqual(movieDimension.year, 2024);
assert.strictEqual(movieDimension.isSeries, false, '1920x1080 must not be treated as Series!');

// 3. Movie with DDP5.1 and EAC3
const movieAudio = parseMediaFileName('Deadpool.and.Wolverine.2024.1080p.DDP5.1.Atmos.x264.mkv');
assert.strictEqual(movieAudio.cleanTitle, 'Deadpool and Wolverine');
assert.strictEqual(movieAudio.year, 2024);
assert.strictEqual(movieAudio.isSeries, false, 'DDP5.1 must not trigger series episode!');

// 4. TV Series with S01E03
const series1 = parseMediaFileName('Breaking.Bad.S01E03.720p.HDTV.x264.mkv');
assert.strictEqual(series1.cleanTitle, 'Breaking Bad');
assert.strictEqual(series1.season, 1);
assert.strictEqual(series1.episode, 3);
assert.strictEqual(series1.resolution, '720p');
assert.strictEqual(series1.isSeries, true);

// 5. TV Series with Season 2 Episode 4 words
const seriesWords = parseMediaFileName('Loki.Season.2.Episode.4.1080p.WEB-DL.mkv');
assert.strictEqual(seriesWords.cleanTitle, 'Loki');
assert.strictEqual(seriesWords.season, 2);
assert.strictEqual(seriesWords.episode, 4);
assert.strictEqual(seriesWords.isSeries, true);

// 6. TV Series with standalone Episode or E05
const seriesEpOnly = parseMediaFileName('Severance.Episode.01.1080p.mkv');
assert.strictEqual(seriesEpOnly.cleanTitle, 'Severance');
assert.strictEqual(seriesEpOnly.season, 1);
assert.strictEqual(seriesEpOnly.episode, 1);
assert.strictEqual(seriesEpOnly.isSeries, true);

const seriesE05 = parseMediaFileName('Severance.E05.720p.mkv');
assert.strictEqual(seriesE05.cleanTitle, 'Severance');
assert.strictEqual(seriesE05.season, 1);
assert.strictEqual(seriesE05.episode, 5);
assert.strictEqual(seriesE05.isSeries, true);

console.log('All 7 parser test cases passed cleanly!');
