/**
 * tests/run-all.mjs
 * Master test runner executing all E2E test suites with structured summary reporting.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testSuites = [
  'tests/e2e/tier1-features.test.ts',
  'tests/e2e/tier2-boundary.test.ts',
  'tests/e2e/tier3-interactions.test.ts',
  'tests/e2e/tier4-workloads.test.ts',
  'tests/e2e/playback-e2e.test.ts',
  'tests/e2e/error-ui-e2e.test.ts',
];

console.log('===============================================================');
console.log('       StreamUp E2E Test Suite Runner (Tiers 1 - 4)            ');
console.log('===============================================================\n');

let totalPassed = 0;
let totalFailed = 0;
const results = [];

async function runSuite(testFile) {
  const relPath = path.relative(process.cwd(), testFile);
  process.stdout.write(`▶ Running suite: ${relPath}... `);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--experimental-strip-types',
        '--loader',
        './tests/infra/ts-loader.mjs',
        testFile,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      const passMatch = stdout.match(/ℹ pass (\d+)/);
      const failMatch = stdout.match(/ℹ fail (\d+)/);
      const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
      const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;

      if (code === 0 && failCount === 0) {
        console.log(`PASSED (${passCount} tests, ${duration}ms)`);
        totalPassed += passCount;
        results.push({ file: relPath, status: 'PASSED', pass: passCount, fail: 0, duration });
      } else {
        console.log(`FAILED (${failCount} failures, ${duration}ms)`);
        totalFailed += failCount || 1;
        results.push({ file: relPath, status: 'FAILED', pass: passCount, fail: failCount || 1, duration });
        console.error(stdout);
        console.error(stderr);
      }
      resolve();
    });
  });
}

async function run() {
  const globalStart = Date.now();
  for (const suite of testSuites) {
    await runSuite(path.resolve(process.cwd(), suite));
  }
  const globalDuration = Date.now() - globalStart;

  console.log('\n===============================================================');
  console.log('                       TEST RUN SUMMARY                        ');
  console.log('===============================================================');
  console.log(`Suites executed : ${testSuites.length}`);
  console.log(`Total tests run : ${totalPassed + totalFailed}`);
  console.log(`Total passed    : ${totalPassed}`);
  console.log(`Total failed    : ${totalFailed}`);
  console.log(`Total duration  : ${globalDuration}ms`);
  console.log('---------------------------------------------------------------');

  if (totalFailed > 0) {
    console.error('❌ SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('✅ ALL TEST SUITES PASSED CLEANLY');
    process.exit(0);
  }
}

run();

