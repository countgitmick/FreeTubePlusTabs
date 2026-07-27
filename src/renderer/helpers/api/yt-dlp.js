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
    // Be conservative about classifying as terminated — only specific
    // unambiguous phrases trigger 404. An over-broad regex misclassifies
    // transient HTTP 400s and "Sign in to confirm you're not a bot"
    // responses as terminal, which short-circuits the scraper fallback.
    const stderr = response.stderrTail ?? ''
    const looksTerminated =
      /http error 404/i.test(stderr) ||
      /channel was terminated/i.test(stderr) ||
      /channel does not exist/i.test(stderr) ||
      /this channel is not available/i.test(stderr)
    return {
      unavailable: false,
      ok: false,
      data: null,
      status: looksTerminated ? 404 : 0,
      reason: stderr || `exit ${response.exitCode}`
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
  const published = derivePublished(entry, liveNow)

  return {
    type: 'video',
    videoId: entry.id,
    title: typeof entry.title === 'string' ? entry.title.trim() : '',
    author: entry.channel ?? entry.uploader ?? channelName ?? '',
    authorId: typeof entry.channel_id === 'string' ? entry.channel_id : channelId,
    description: entry.description ?? undefined,
    viewCount: Number.isFinite(entry.view_count) ? entry.view_count : null,
    published,
    // Dates only exist here because we ask for them with
    // --extractor-args youtubetab:approximate_date; a bare --flat-playlist
    // carries no timestamp at all. They are day-granular estimates derived
    // from YouTube's relative "3 weeks ago" text — the same class of value the
    // scraper produces — so flag them so the cross-channel sort keeps exact
    // RSS timestamps ahead of them. A live stream's Date.now() is not an
    // estimate of anything, so it isn't flagged.
    publishedApprox: !liveNow && Number.isFinite(published),
    lengthSeconds: liveNow || isUpcoming
      ? ''
      : (Number.isFinite(entry.duration) ? entry.duration : ''),
    liveNow,
    isUpcoming,
    // The /videos flat-playlist mixes shorts in. yt-dlp gives shorts a
    // canonical /shorts/ URL, so we classify on that — the same definitive
    // signal the channel RSS feed uses — and let the fetcher route them to
    // the shorts cache instead of leaking them into the videos feed.
    isShort: isShortEntry(entry),
    premiereDate: isUpcoming && Number.isFinite(entry.release_timestamp)
      ? new Date(entry.release_timestamp * 1000)
      : undefined
  }
}

/**
 * A yt-dlp flat-playlist entry is a short when its URL is a /shorts/ URL.
 * @param {object} entry
 * @returns {boolean}
 */
function isShortEntry(entry) {
  const url = entry.url ?? entry.webpage_url ?? ''
  return typeof url === 'string' && url.includes('/shorts/')
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
