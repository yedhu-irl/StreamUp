// scripts/pack-webos-ipk.mjs
// Packages the webos-dist/ directory into a standard LG webOS .ipk file (opkg/Debian ar format)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const webosDistDir = path.join(rootDir, 'webos-dist');
const appinfoPath = path.join(webosDistDir, 'appinfo.json');
const outputDir = path.join(rootDir, 'dist-ipk');
const stagingDir = path.join(rootDir, '.webos-pack-staging');

if (!fs.existsSync(appinfoPath)) {
  console.error('❌ webos-dist/appinfo.json not found. Run "npm run webos:prepare" first.');
  process.exit(1);
}

const appinfo = JSON.parse(fs.readFileSync(appinfoPath, 'utf8'));
const appId = appinfo.id || 'com.streamup.tv';
const appVersion = appinfo.version || '1.0.0';
const ipkFileName = `${appId}_${appVersion}_all.ipk`;

console.log(`📦 Packaging webOS TV app: ${appId} (v${appVersion})...`);

// 1. Clean and prepare directories
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

// 2. Prepare control file and control.tar.gz
const controlDir = path.join(stagingDir, 'control_src');
fs.mkdirSync(controlDir, { recursive: true });

const controlContent = [
  `Package: ${appId}`,
  `Version: ${appVersion}`,
  `Section: misc`,
  `Priority: optional`,
  `Architecture: all`,
  `Maintainer: ${appinfo.vendor || 'StreamUp'}`,
  `Description: ${appinfo.title || 'StreamUp'} for LG webOS TV`,
  '',
].join('\n');

fs.writeFileSync(path.join(controlDir, 'control'), controlContent, 'utf8');

const controlTarPath = path.join(stagingDir, 'control.tar.gz');
execSync(`tar -czf "${controlTarPath}" -C "${controlDir}" control`);

// 3. Prepare data directory and data.tar.gz
// webOS app files must reside under usr/palm/applications/<appId>/
const appInstallDir = path.join(stagingDir, 'data_src', 'usr', 'palm', 'applications', appId);
fs.mkdirSync(appInstallDir, { recursive: true });

fs.cpSync(webosDistDir, appInstallDir, { recursive: true });

const dataTarPath = path.join(stagingDir, 'data.tar.gz');
execSync(`tar -czf "${dataTarPath}" -C "${path.join(stagingDir, 'data_src')}" usr`);

// 4. Assemble the ar (.ipk) package
function makeArHeader(filename, size, timestamp = Math.floor(Date.now() / 1000)) {
  const buf = Buffer.alloc(60, 0x20); // space padded 60 bytes
  buf.write(filename.padEnd(16, ' '), 0, 16, 'ascii');
  buf.write(String(timestamp).padEnd(12, ' '), 16, 12, 'ascii');
  buf.write('0     ', 28, 6, 'ascii');
  buf.write('0     ', 34, 6, 'ascii');
  buf.write('100644  ', 40, 8, 'ascii');
  buf.write(String(size).padEnd(10, ' '), 48, 10, 'ascii');
  buf[58] = 0x60; // `
  buf[59] = 0x0a; // \n
  return buf;
}

const magic = Buffer.from('!<arch>\n', 'ascii');
const debianBinary = Buffer.from('2.0\n', 'ascii');
const debHeader = makeArHeader('debian-binary', debianBinary.length);

const controlBuf = fs.readFileSync(controlTarPath);
const controlHeader = makeArHeader('control.tar.gz', controlBuf.length);

const dataBuf = fs.readFileSync(dataTarPath);
const dataHeader = makeArHeader('data.tar.gz', dataBuf.length);

// ar file entries must be padded with a newline if size is odd
function padArEntry(buf) {
  if (buf.length % 2 !== 0) {
    return Buffer.concat([buf, Buffer.from('\n', 'ascii')]);
  }
  return buf;
}

const ipkBuffer = Buffer.concat([
  magic,
  debHeader,
  padArEntry(debianBinary),
  controlHeader,
  padArEntry(controlBuf),
  dataHeader,
  padArEntry(dataBuf),
]);

const finalIpkPath = path.join(outputDir, ipkFileName);
fs.writeFileSync(finalIpkPath, ipkBuffer);

// 5. Clean up staging
fs.rmSync(stagingDir, { recursive: true, force: true });

const stats = fs.statSync(finalIpkPath);
console.log(`✅ Successfully generated LG webOS TV package:`);
console.log(`   File: ${finalIpkPath}`);
console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

