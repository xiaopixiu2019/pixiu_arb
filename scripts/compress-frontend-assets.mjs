import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** Build-time public assets only; original files remain available for identity clients. */
export async function compressFrontendAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|css|svg|ttf)$/.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const original = await readFile(path);
    if (original.length < 1024) continue;
    const variants = await Promise.all([
      deflate(original, { level: 6 }),
      brotli(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
    ]);
    for (const [index, suffix] of ['gz', 'br'].entries()) {
      if (variants[index].length < original.length) await writeFile(`${path}.${suffix}`, variants[index]);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await compressFrontendAssets(fileURLToPath(new URL('../apps/frontend/dist/assets', import.meta.url)));
}
