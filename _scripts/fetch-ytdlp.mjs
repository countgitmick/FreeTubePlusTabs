// Downloads the yt-dlp standalone binary into vendor/yt-dlp/<platform>/ so it
// can be bundled into the packaged app via mac.extraResources /
// win.extraResources / linux.extraResources in ebuilder.config.mjs.
//
// This lets users download videos (see the player's Download button) without
// installing yt-dlp themselves. Run automatically as part of `yarn build`
// (see the "build" script in package.json); you can also run it directly
// with `node _scripts/fetch-ytdlp.mjs [darwin|win32|linux]`.
//
// The binary itself is NOT committed to the repo (see .gitignore) — it's
// fetched fresh on every build instead, so builds always ship a current
// yt-dlp without bloating the git history with ~30 MB binaries.

import { mkdir, writeFile, chmod, access } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')

// yt-dlp publishes this stable, version-independent URL that always
// redirects to the latest release's matching asset.
// https://github.com/yt-dlp/yt-dlp#release-files
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

const TARGETS = {
  // yt-dlp_macos is a universal2 binary — covers Intel and Apple Silicon.
  darwin: { asset: 'yt-dlp_macos', outDir: 'mac', outFile: 'yt-dlp', mode: 0o755 },
  win32: { asset: 'yt-dlp.exe', outDir: 'win', outFile: 'yt-dlp.exe', mode: 0o644 },
  linux: { asset: 'yt-dlp_linux', outDir: 'linux', outFile: 'yt-dlp', mode: 0o755 },
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function fetchYtdlp(platform) {
  const target = TARGETS[platform]
  if (!target) {
    throw new Error(`No yt-dlp bundling target for platform "${platform}"`)
  }

  const outDir = path.join(repoRoot, 'vendor', 'yt-dlp', target.outDir)
  const outPath = path.join(outDir, target.outFile)

  console.log(`[fetch-ytdlp] downloading ${target.asset} for ${platform}...`)

  const url = `${RELEASE_BASE}/${target.asset}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()

  await mkdir(outDir, { recursive: true })
  await writeFile(outPath, Buffer.from(arrayBuffer))
  await chmod(outPath, target.mode)

  console.log(`[fetch-ytdlp] saved to ${path.relative(repoRoot, outPath)} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)`)
}

async function main() {
  const requestedPlatform = process.argv[2] || process.platform

  try {
    await fetchYtdlp(requestedPlatform)
  } catch (err) {
    // Don't fail the whole build over this — a build without the bundled
    // binary still works, it just falls back to a system-installed yt-dlp
    // (or no download support) like upstream FreeTube always has.
    console.warn(`[fetch-ytdlp] WARNING: could not fetch yt-dlp (${err.message}).`)
    console.warn('[fetch-ytdlp] The build will continue without a bundled yt-dlp binary.')

    const target = TARGETS[requestedPlatform]
    const outPath = target ? path.join(repoRoot, 'vendor', 'yt-dlp', target.outDir, target.outFile) : null
    if (outPath && await fileExists(outPath)) {
      console.warn(`[fetch-ytdlp] keeping previously downloaded binary at ${path.relative(repoRoot, outPath)}`)
    }
  }
}

main()
