import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const INDEX_EXTENSIONS = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context);
  } catch (err) {
    if (
      err.code === 'ERR_MODULE_NOT_FOUND' ||
      err.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
    ) {
      // 1. If it's a relative/absolute path
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const parentUrl = context.parentURL;
        if (parentUrl) {
          const parentPath = fileURLToPath(parentUrl);
          const parentDir = path.dirname(parentPath);
          const targetPath = path.resolve(parentDir, specifier);

          // Check if file with extension exists
          for (const ext of EXTENSIONS) {
            const candidate = targetPath + ext;
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
          }

          // Check if directory with index exists
          if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
            for (const ext of INDEX_EXTENSIONS) {
              const candidate = targetPath + ext;
              if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return { url: pathToFileURL(candidate).href, shortCircuit: true };
              }
            }
          }
        }
      }

      // 2. If it's a package import that threw ERR_UNSUPPORTED_DIR_IMPORT (e.g. telegram/sessions)
      if (err.url) {
        try {
          const targetPath = fileURLToPath(err.url);
          if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
            for (const ext of ['index.js', 'index.mjs']) {
              const candidate = path.join(targetPath, ext);
              if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return { url: pathToFileURL(candidate).href, shortCircuit: true };
              }
            }
          }
        } catch (_) {}
      }
    }
    throw err;
  }
}

