// Renderer-side wrapper around the yt-dlp sidecar IPC.
//
// Returns FreeTube's canonical video shape (matching parseLocalListVideo
// in ./local.js — same key set so downstream consumers don't care which
// strategy produced the entry).

/**
 * @typedef {object} YtdlpChannelResult
 * @property {string | null} name
 * @property {string | null} thumbnailUrl
 * @property {any[]} videos
 */

/**
 * @typedef {object} YtdlpFetchOutcome
 * @property {boolean} unavailable  yt-dlp not on PATH; skip strategy entirely
 * @property {boolean} ok
 * @property {YtdlpChannelResult | null} data
 * @property {number} status         pseudo-HTTP status: 200 ok, 404 channel gone, 0 other failure
 * @property {string} reason         brief human-readable reason on failure
 */

/**
 * Fetch the most recent N videos from a channel via the yt-dlp sidecar.
 * Never throws; returns a structured outcome.
 * @param {string} channelId
 * @param {number} [limit]
 * @returns {Promise<YtdlpFetchOutcome>}
 */
export async function getYtdlpChannelVideos(channelId, limit = 30) {
  if (!process.env.IS_ELECTRON) {
    return { unavailable: true, ok: false, data: null, status: 0, reason: 'not electron' }
  }

  const response = await window.ftElectron.ytdlpFetchChannelVideos({ channelId, limit })

  if (!response.available) {
    return { unavailable: true, ok: false, data: null, status: 0, reason: 'yt-dlp not installed' }
  }

  if (!response.ok) {
    // yt-dlp emits this exact phrase when a channel doesn't have a videos
    // tab or the channel is terminated. Treat as 404 so the coordinator
    // doesn't keep retrying a known-dead channel.
    const looksTerminated = /does not have|does not exist|http error 404|terminated/i.test(response.stderrTail ?? '')
    return {
      unavailable: false,
      ok: false,
      data: null,
      status: looksTerminated ? 404 : 0,
      reason: response.stderrTail ?? `exit ${response.exitCode}`
    }
  }

  const raw = response.data
  if (raw == null || !Array.isArray(raw.entries)) {
    return { unavailable: false, ok: false, data: null, status: 0, reason: 'empty response' }
  }

  const channelName = raw.name ?? null
  const videos = raw.entries
    .map((entry) => parseYtdlpEntry(entry, channelId, channelName))
    .filter((v) => v != null)

  return {
    unavailable: false,
    ok: true,
    data: {
      name: channelName,
      thumbnailUrl: raw.thumbnailUrl ?? null,
      videos
    },
    status: 200,
    reason: ''
  }
}

/**
 * Map one yt-dlp flat-playlist entry to FreeTube's video shape.
 * Returns null for unparseable entries (missing id).
 */
function parseYtdlpEntry(entry, channelId, channelName) {
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
    return null
  }

  const liveStatus = entry.live_status
  const liveNow = liveStatus === 'is_live'
  const isUpcoming = liveStatus === 'is_upcoming'

  return {
    type: 'video',
    videoId: entry.id,
    title: typeof entry.title === 'string' ? entry.title.trim() : '',
    author: entry.channel ?? entry.uploader ?? channelName ?? '',
    authorId: typeof entry.channel_id === 'string' ? entry.channel_id : channelId,
    description: entry.description ?? undefined,
    viewCount: Number.isFinite(entry.view_count) ? entry.view_count : null,
    published: derivePublished(entry, liveNow),
    lengthSeconds: liveNow || isUpcoming
      ? ''
      : (Number.isFinite(entry.duration) ? entry.duration : ''),
    liveNow,
    isUpcoming,
    premiereDate: isUpcoming && Number.isFinite(entry.release_timestamp)
      ? new Date(entry.release_timestamp * 1000)
      : undefined
  }
}

function derivePublished(entry, liveNow) {
  if (liveNow) return Date.now()
  if (Number.isFinite(entry.timestamp)) return entry.timestamp * 1000
  if (typeof entry.upload_date === 'string' && /^\d{8}$/.test(entry.upload_date)) {
    const yyyy = Number(entry.upload_date.slice(0, 4))
    const mm = Number(entry.upload_date.slice(4, 6))
    const dd = Number(entry.upload_date.slice(6, 8))
    return Date.UTC(yyyy, mm - 1, dd)
  }
  return undefined
}
