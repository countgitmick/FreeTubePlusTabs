// Main-process wrapper for spawning yt-dlp as a sidecar.
//
// Why: youtubei.js's per-channel /browse extraction has been unreliable since
// YouTube tightened anti-bot in 2026. yt-dlp is updated weekly by a team and
// typically fixes YouTube changes within hours. Using it as a strict-fallback
// strategy in the subscription refresh coordinator keeps the cache populated
// when the InnerTube path 400s.
//
// Lifecycle:
//   detectYtdlp()        — called once on app.whenReady, sets cached path
//   isYtdlpAvailable()   — synchronous getter, used by the IPC handler
//   fetchChannelVideos() — spawns yt-dlp, parses JSON, returns structured data
//
// Discovery order:
//   1. A yt-dlp binary bundled into the app itself, under
//      <resourcesPath>/bin/yt-dlp(.exe). Only present in a packaged build —
//      see _scripts/fetch-ytdlp.mjs and mac.extraResources in
//      _scripts/ebuilder.config.mjs. Lets end users download videos out of
//      the box with nothing extra to install.
//   2. Env var FREETUBE_YTDLP_PATH (NixOS wrapper sets this)
//   3. PATH lookup via `which`/`where`
//
// All network work runs in yt-dlp itself; this file only handles process I/O.

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

const FETCH_TIMEOUT_MS = 30 * 1000
const STDOUT_CAP_BYTES = 4 * 1024 * 1024 // 4 MB; channel listing JSON is ~50–200 KB
const STDERR_CAP_BYTES = 64 * 1024
const STDERR_TAIL_BYTES = 2 * 1024
// A bundled yt-dlp's first invocation can take well over 5s on some macOS
// setups (PyInstaller onefile self-extraction gets heavily CPU-throttled when
// the child has no controlling TTY, e.g. when spawned from Electron's main
// process), so the probe needs real headroom or a slow-but-working binary
// gets wrongly reported as "not found".
const VERSION_PROBE_TIMEOUT_MS = 20000

// Cap concurrent yt-dlp processes regardless of how aggressive the
// coordinator's worker pool is. The coordinator's cold-start pool is 6;
// allowing 6 simultaneous yt-dlp invocations could spike ~360 MB on
// low-RAM systems. 3 keeps the worst-case spike under ~180 MB.
const MAX_CONCURRENT = 3

const CHANNEL_ID_RE = /^UC[\w-]{22}$/
const VIDEO_ID_RE = /^[\w-]{11}$/

// No overall timeout: a video download can legitimately take many minutes.
// We rely on the renderer's cancel handle (killing the child) instead.
const DOWNLOAD_STDERR_TAIL_BYTES = 4 * 1024
// yt-dlp emits a progress line per percent-ish tick with --newline; this is
// cheap to match and doesn't need the rest of its (very wide) progress template.
const PROGRESS_RE = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/

let ytdlpPath = null
let detected = false
let inFlightCount = 0
const waitQueue = []

/**
 * Find yt-dlp at app startup. Caches the result for the session.
 * Resolves on success and on graceful failure — never rejects, so the
 * call site doesn't have to special-case "yt-dlp isn't installed."
 */
export async function detectYtdlp() {
  if (detected) return
  detected = true

  const bundledPath = getBundledYtdlpPath()
  if (bundledPath) {
    const version = await probeYtdlpVersion(bundledPath)
    if (version) {
      ytdlpPath = bundledPath
      console.warn(`[ytdlp] detected bundled binary at ${bundledPath} (v${version})`)
      return
    }
    console.warn(`[ytdlp] bundled binary at ${bundledPath} did not respond to --version, falling back`)
  }

  const envPath = process.env.FREETUBE_YTDLP_PATH
  if (envPath) {
    const version = await probeYtdlpVersion(envPath)
    if (version) {
      ytdlpPath = envPath
      console.warn(`[ytdlp] detected via FREETUBE_YTDLP_PATH at ${envPath} (v${version})`)
      return
    }
    console.warn(`[ytdlp] FREETUBE_YTDLP_PATH=${envPath} did not respond to --version`)
  }

  const lookupCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(lookupCmd, ['yt-dlp'], { timeout: 5000 })
    const candidate = stdout.trim().split(/\r?\n/)[0]
    if (candidate) {
      const version = await probeYtdlpVersion(candidate)
      if (version) {
        ytdlpPath = candidate
        console.warn(`[ytdlp] detected via PATH at ${candidate} (v${version})`)
        return
      }
    }
  } catch {
    // not found
  }

  console.warn('[ytdlp] NOT FOUND on PATH (env FREETUBE_YTDLP_PATH unset). Subscriptions fall back to RSS + youtubei.js scraper only.')
}

/**
 * @returns {string | null} Path to the yt-dlp binary bundled with this build,
 *   or null when running unpackaged (dev) or on a platform we don't bundle
 *   one for yet.
 */
function getBundledYtdlpPath() {
  // In dev, `app.isPackaged` is false and process.resourcesPath points at
  // Electron's own resources, not ours — there's nothing bundled to find.
  if (!app.isPackaged) {
    return null
  }

  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return path.join(process.resourcesPath, 'bin', binName)
}

export function isYtdlpAvailable() {
  return ytdlpPath != null
}

// --- Concurrency slot management ---
// Cap simultaneous yt-dlp processes globally. Acquired before spawn,
// released after the child settles (or never acquired if validation fails).

function acquireSlot() {
  if (inFlightCount < MAX_CONCURRENT) {
    inFlightCount++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      inFlightCount++
      resolve()
    })
  })
}

function releaseSlot() {
  inFlightCount--
  const next = waitQueue.shift()
  if (next) next()
}

async function probeYtdlpVersion(binPath) {
  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS })
    return stdout.trim() || 'unknown'
  } catch {
    return null
  }
}

/**
 * Fetch the most recent N videos from a channel via yt-dlp.
 * @param {string} channelId  Must match /^UC[\w-]{22}$/.
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number | null,
 *   stderrTail: string,
 *   elapsedMs: number,
 *   data: { name: string | null, thumbnailUrl: string | null, entries: any[] } | null
 * }>}
 */
export async function fetchChannelVideos(channelId, options = {}) {
  const startedAt = Date.now()

  if (!ytdlpPath) {
    return { ok: false, exitCode: null, stderrTail: 'yt-dlp not available', elapsedMs: 0, data: null }
  }
  if (typeof channelId !== 'string' || !CHANNEL_ID_RE.test(channelId)) {
    return { ok: false, exitCode: null, stderrTail: 'bad channelId', elapsedMs: 0, data: null }
  }

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30

  // Wait for a slot in the per-process semaphore.
  await acquireSlot()

  // Argv-style spawn — never pass user data through a shell. The args here
  // are all either constants or validated by the regex above.
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--socket-timeout', '30',
    '--playlist-end', String(limit),
    '--extractor-args', 'youtube:player_client=android,web',
    // Without this a flat playlist carries no timestamp, upload_date or
    // release_timestamp at all, so every entry ends up undated and sorts to
    // the bottom of the merged subscriptions feed. This yields day-granular
    // estimates, which parseYtdlpEntry flags as publishedApprox.
    '--extractor-args', 'youtubetab:approximate_date',
    `https://www.youtube.com/channel/${channelId}/videos`
  ]

  return await new Promise((resolve) => {
    const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks = []
    const stderrChunks = []
    let killedForTimeout = false
    let killedForOverflow = false
    let killTimer = null
    let settled = false

    const timer = setTimeout(() => {
      killedForTimeout = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
    }, FETCH_TIMEOUT_MS)

    const clearTimers = () => {
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
    }

    // Both 'error' and 'close' can fire for the same child — node guarantees
    // 'error' first, but we guard against double-resolve and double-release
    // explicitly so a future event-order change can't double-count the
    // semaphore slot.
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimers()
      releaseSlot()
      resolve(value)
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_CAP_BYTES) {
        if (!killedForOverflow) {
          killedForOverflow = true
          child.kill('SIGTERM')
        }
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > STDERR_CAP_BYTES) return
      stderrChunks.push(chunk)
    })

    child.on('error', (err) => {
      // ENOENT here (after detection) means yt-dlp got removed mid-session.
      // Flip the cached path off so future calls short-circuit.
      if (err.code === 'ENOENT') {
        ytdlpPath = null
        detected = false
      }
      settle({
        ok: false,
        exitCode: null,
        stderrTail: err.message,
        elapsedMs: Date.now() - startedAt,
        data: null
      })
    })

    child.on('close', (code) => {
      const elapsedMs = Date.now() - startedAt
      const stderrFull = Buffer.concat(stderrChunks).toString('utf8')
      const stderrTail = stderrFull.length > STDERR_TAIL_BYTES
        ? '...' + stderrFull.slice(-STDERR_TAIL_BYTES)
        : stderrFull

      if (killedForTimeout) {
        settle({ ok: false, exitCode: null, stderrTail: `timeout after ${FETCH_TIMEOUT_MS}ms`, elapsedMs, data: null })
        return
      }
      if (killedForOverflow) {
        settle({ ok: false, exitCode: code, stderrTail: 'stdout exceeded cap', elapsedMs, data: null })
        return
      }
      if (code !== 0) {
        settle({ ok: false, exitCode: code, stderrTail, elapsedMs, data: null })
        return
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (err) {
        settle({ ok: false, exitCode: code, stderrTail: `json parse failed: ${err.message}`, elapsedMs, data: null })
        return
      }

      // Channel thumbnail — must be the square avatar, NOT a banner.
      // yt-dlp's `thumbnails` array mixes the avatar in with the wide banner
      // images (avatar_uncropped, banner_uncropped, tv_banner_uncropped, ...).
      // Picking the largest by area always lands on the banner, which then
      // renders as a stretched ellipse wherever we treat it as a round avatar.
      // Restrict to avatars (by id, else square-ish aspect) before taking the
      // largest; only fall back to the raw last entry when nothing qualifies.
      let thumbnailUrl = null
      if (Array.isArray(parsed.thumbnails) && parsed.thumbnails.length > 0) {
        const isAvatar = (t) =>
          (typeof t.id === 'string' && t.id.includes('avatar')) ||
          (t.width > 0 && t.height > 0 && Math.abs(t.width - t.height) <= t.width * 0.1)
        const avatars = parsed.thumbnails.filter(isAvatar)
        const pool = avatars.length > 0 ? avatars : parsed.thumbnails

        let best = pool[pool.length - 1]
        let bestArea = (best.width || 0) * (best.height || 0)
        for (const t of pool) {
          const area = (t.width || 0) * (t.height || 0)
          if (area > bestArea) {
            best = t
            bestArea = area
          }
        }
        thumbnailUrl = best.url ?? null
      }

      settle({
        ok: true,
        exitCode: 0,
        stderrTail: '',
        elapsedMs,
        data: {
          name: parsed.channel ?? parsed.uploader ?? null,
          thumbnailUrl,
          entries: Array.isArray(parsed.entries) ? parsed.entries : []
        }
      })
    })
  })
}

// Tracks in-flight downloads by requestId so a cancel request can kill the
// right child process. Entries are removed once the child settles.
const activeDownloads = new Map()

/**
 * Download a single video (or just its audio) via yt-dlp.
 *
 * Does not use the shared `acquireSlot()` semaphore used by
 * `fetchChannelVideos()` — a download can run for minutes and shouldn't be
 * capped by (or compete with) the short-lived subscription-refresh fetches.
 *
 * @param {string} requestId  Opaque id the renderer uses to correlate
 *   progress events and cancellation with this call.
 * @param {string} videoId    Must match /^[\w-]{11}$/.
 * @param {'video' | 'audio'} kind
 * @param {string} outputDir  Absolute path to an existing, writable directory.
 * @param {string} outputBasename  Filename without extension, already
 *   sanitized by the caller (no path separators).
 * @param {(percent: number) => void} onProgress
 * @returns {Promise<{ ok: boolean, error: string | null, filePath: string | null }>}
 */
export async function downloadVideo(requestId, videoId, kind, outputDir, outputBasename, onProgress) {
  if (!ytdlpPath) {
    return { ok: false, error: 'yt-dlp not available', filePath: null }
  }
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    return { ok: false, error: 'bad videoId', filePath: null }
  }
  if (kind !== 'video' && kind !== 'audio') {
    return { ok: false, error: 'bad kind', filePath: null }
  }

  // Argv-style spawn, no shell — outputDir/outputBasename are caller-validated
  // and never interpolated into a command string. Video downloads get the
  // resolution in the filename (yt-dlp fills in %(width)s/%(height)s from the
  // format it actually picked); doesn't apply to audio-only downloads.
  const outputTemplate = kind === 'audio'
    ? `${outputDir}/${outputBasename}.%(ext)s`
    : `${outputDir}/${outputBasename} [%(width)sx%(height)s].%(ext)s`

  const formatArgs = kind === 'audio'
    ? ['-x', '--audio-format', 'mp3']
    : ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']

  const args = [
    ...formatArgs,
    '--newline',
    '--no-playlist',
    '--no-part',
    '--extractor-args', 'youtube:player_client=android,web',
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    `https://www.youtube.com/watch?v=${videoId}`
  ]

  return await new Promise((resolve) => {
    const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    activeDownloads.set(requestId, child)

    let stdoutTail = ''
    const stderrChunks = []
    let stderrBytes = 0
    let settled = false

    const settle = (value) => {
      if (settled) return
      settled = true
      activeDownloads.delete(requestId)
      resolve(value)
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdoutTail = (stdoutTail + text).slice(-4096)

      const match = PROGRESS_RE.exec(text)
      if (match) {
        onProgress(Math.min(100, parseFloat(match[1])))
      }
    })

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > DOWNLOAD_STDERR_TAIL_BYTES * 4) return
      stderrChunks.push(chunk)
    })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        ytdlpPath = null
        detected = false
      }
      settle({ ok: false, error: err.message, filePath: null })
    })

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        settle({ ok: false, error: 'cancelled', filePath: null })
        return
      }

      if (code !== 0) {
        const stderrFull = Buffer.concat(stderrChunks).toString('utf8')
        const stderrTail = stderrFull.length > DOWNLOAD_STDERR_TAIL_BYTES
          ? '...' + stderrFull.slice(-DOWNLOAD_STDERR_TAIL_BYTES)
          : stderrFull
        settle({ ok: false, error: stderrTail || `yt-dlp exited with code ${code}`, filePath: null })
        return
      }

      // `--print after_move:filepath` writes the final file path as its own
      // stdout line once the file is in place (after any merge/remux step).
      const lines = stdoutTail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const filePath = lines.length > 0 ? lines[lines.length - 1] : null

      settle({ ok: true, error: null, filePath })
    })
  })
}

/**
 * Cancel an in-flight download started via downloadVideo(). No-op if the
 * requestId is unknown (already finished, or never started).
 * @param {string} requestId
 */
export function cancelDownload(requestId) {
  const child = activeDownloads.get(requestId)
  if (child) {
    child.kill('SIGTERM')
  }
}
