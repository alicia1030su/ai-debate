/**
 * Writes `packages/web/static/manifest.json`, the asset inventory the bundled
 * server reads at startup.
 *
 * The server locates its web assets by an explicit list rather than by walking
 * a directory: inside a single-executable image there is no directory to walk,
 * and a list that has to be regenerated is a list that can go stale — which is
 * exactly how a console ends up rendering with a missing stylesheet. Keeping the
 * manifest a build artifact means it cannot disagree with what was just built.
 *
 * Part of `node scripts/build-web.mjs`; not meant to be run on its own.
 */

import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Files that are served but never listed: build metadata, not content. */
const SKIP = new Set(['manifest.json', 'app.js.map'])

/**
 * Walk one directory and collect its files as `/`-separated relative paths.
 *
 * @param {string} root Directory to walk.
 * @param {string} prefix Relative prefix accumulated so far.
 * @returns {Promise<string[]>} Relative paths, sorted for a reproducible file.
 */
async function collect(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...(await collect(root, relative)))
      continue
    }
    if (SKIP.has(entry.name)) continue
    found.push(relative)
  }
  return found
}

/**
 * Write the manifest for a static directory.
 *
 * @param {string} staticDir Directory whose contents are served.
 * @param {string} [outputPath] Where to write; defaults to `<staticDir>/manifest.json`.
 * @returns {Promise<number>} How many assets were listed.
 */
export async function writeAssetManifest(staticDir, outputPath) {
  const files = (await collect(staticDir)).sort()
  const manifest = { assets: files.map((relative) => `web/${relative}`) }
  await writeFile(outputPath ?? path.join(staticDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return files.length
}
