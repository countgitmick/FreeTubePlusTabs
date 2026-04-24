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
//   1. Env var FREETUBE_YTDLP_PATH (NixOS wrapper sets this)
//   2. PATH lookup via `which`/`where`
//
// All network work runs in yt-dlp itself; this file only handles process I/O.

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const FETCH_TIMEOUT_MS = 30 * 1000
const STDOUT_CAP_BYTES = 4 * 1024 * 1024 // 4 MB; channel listing JSON is ~50–200 KB
const STDERR_CAP_BYTES = 64 * 1024
const STDERR_TAIL_BYTES = 2 * 1024
const VERSION_PROBE_TIMEOUT_MS = 5000

const CHANNEL_ID_RE = /^UC[\w-]{22}$/

let ytdlpPath = null
let detected = false

/**
 * Find yt-dlp at app startup. Caches the result for the session.
 * Resolves on success and on graceful failure — never rejects, so the
 * call site doesn't have to special-case "yt-dlp isn't installed."
 */
export async function detectYtdlp() {
  if (detected) return
  detected = true

  const envPath = process.env.FREETUBE_YTDLP_PATH
  if (envPath) {
    if (await probeYtdlpVersion(envPath)) {
      ytdlpPath = envPath
      return
    }
    console.warn(`[ytdlp] FREETUBE_YTDLP_PATH=${envPath} did not respond to --version`)
  }

  const lookupCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(lookupCmd, ['yt-dlp'], { timeout: 5000 })
    const candidate = stdout.trim().split(/\r?\n/)[0]
    if (candidate && await probeYtdlpVersion(candidate)) {
      ytdlpPath = candidate
      return
    }
  } catch {
    // not found
  }

  console.warn('[ytdlp] not found on PATH; falling back to scraper for channel videos')
}

export function isYtdlpAvailable() {
  return ytdlpPath != null
}

async function probeYtdlpVersion(binPath) {
  try {
    await execFileAsync(binPath, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
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

  // Argv-style spawn — never pass user data through a shell. The args here
  // are all either constants or validated by the regex above.
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--socket-timeout', '30',
    '--playlist-end', String(limit),
    '--extractor-args', 'youtube:player_client=android,web',
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
      clearTimers()
      // ENOENT here (after detection) means yt-dlp got removed mid-session.
      // Flip the cached path off so future calls short-circuit.
      if (err.code === 'ENOENT') {
        ytdlpPath = null
        detected = false
      }
      resolve({
        ok: false,
        exitCode: null,
        stderrTail: err.message,
        elapsedMs: Date.now() - startedAt,
        data: null
      })
    })

    child.on('close', (code) => {
      clearTimers()
      const elapsedMs = Date.now() - startedAt
      const stderrFull = Buffer.concat(stderrChunks).toString('utf8')
      const stderrTail = stderrFull.length > STDERR_TAIL_BYTES
        ? '...' + stderrFull.slice(-STDERR_TAIL_BYTES)
        : stderrFull

      if (killedForTimeout) {
        resolve({ ok: false, exitCode: null, stderrTail: `timeout after ${FETCH_TIMEOUT_MS}ms`, elapsedMs, data: null })
        return
      }
      if (killedForOverflow) {
        resolve({ ok: false, exitCode: code, stderrTail: 'stdout exceeded cap', elapsedMs, data: null })
        return
      }
      if (code !== 0) {
        resolve({ ok: false, exitCode: code, stderrTail, elapsedMs, data: null })
        return
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (err) {
        resolve({ ok: false, exitCode: code, stderrTail: `json parse failed: ${err.message}`, elapsedMs, data: null })
        return
      }

      // Best thumbnail — pick the largest by area, fall back to last entry.
      let thumbnailUrl = null
      if (Array.isArray(parsed.thumbnails) && parsed.thumbnails.length > 0) {
        let best = parsed.thumbnails[parsed.thumbnails.length - 1]
        let bestArea = (best.width || 0) * (best.height || 0)
        for (const t of parsed.thumbnails) {
          const area = (t.width || 0) * (t.height || 0)
          if (area > bestArea) {
            best = t
            bestArea = area
          }
        }
        thumbnailUrl = best.url ?? null
      }

      resolve({
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
