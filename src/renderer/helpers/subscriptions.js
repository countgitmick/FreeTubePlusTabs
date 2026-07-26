import store from '../store/index'

/**
 * Process items with a fixed concurrency budget. Results come back in input order.
 * Respects an optional AbortSignal: stops launching new work once aborted. Workers
 * already in flight are not cancelled here — callers should check `signal.aborted`
 * inside their worker and bail out cheaply.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{ concurrency?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, worker, options = {}) {
  const { concurrency = 6, signal } = options
  const results = new Array(items.length)
  let cursor = 0

  async function runWorker() {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  const pool = []
  for (let i = 0; i < workerCount; i++) {
    pool.push(runWorker())
  }
  await Promise.all(pool)
  return results
}

/**
 * Wrap a fetch function so that transient failures (5xx, 429, thrown errors)
 * are retried with jittered backoff. 404 and 403 are considered terminal and
 * returned immediately — 404 means "gone", 403 means the caller will pivot to
 * a different backend anyway.
 *
 * @param {(url: string, options?: object) => Promise<{ ok: boolean, status: number }>} fetchFn
 * @param {{ retries?: number, baseDelayMs?: number }} [options]
 */
export function withRetry(fetchFn, options = {}) {
  const { retries = 2, baseDelayMs = 500 } = options
  return async function retryingFetch(url, fetchOptions) {
    let lastResponse
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchFn(url, fetchOptions)
        if (response.ok || response.status === 404 || response.status === 403) {
          return response
        }
        lastResponse = response
        lastError = null
      } catch (err) {
        lastError = err
        lastResponse = null
      }
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(3, attempt) + Math.random() * 200
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    if (lastError) throw lastError
    return lastResponse
  }
}

/**
 * Filtering and sort based on user preferences
 * @param {any[]} videos
 */
export function updateVideoListAfterProcessing(videos) {
  let videoList = videos

  if (store.getters.getHideLiveStreams) {
    videoList = videoList.filter(item => {
      return (!item.liveNow && !item.isUpcoming)
    })
  }

  if (store.getters.getHideUpcomingPremieres) {
    videoList = videoList.filter(item => {
      if (item.isRSS) {
        // viewCount is our only method of detecting premieres in RSS
        // data without sending an additional request.
        // If we ever get a better flag, use it here instead.
        return item.viewCount !== '0'
      }
      // Observed for premieres in Local API Subscriptions.
      return (item.premiereDate == null ||
        // Invidious API
        // `premiereTimestamp` only available on premiered videos
        // https://docs.invidious.io/api/common_types/#videoobject
        item.premiereTimestamp == null
      )
    })
  }

  // ordered last to show first eligible video from channel
  // if the first one incidentally failed one of the above checks
  if (store.getters.getOnlyShowLatestFromChannel) {
    const authors = new Map()
    videoList = videoList.filter((video) => {
      if (!video.authorId) {
        return true
      }

      if (!authors.has(video.authorId)) {
        authors.set(video.authorId, 1)
        return true
      } else {
        const currentVideos = authors.get(video.authorId)

        if (currentVideos < store.getters.getOnlyShowLatestFromChannelNumber) {
          authors.set(video.authorId, currentVideos + 1)
          return true
        }
      }

      return false
    })
  }

  videoList.sort((a, b) => {
    const bTime = Number.isFinite(b.published) ? b.published : 0
    const aTime = Number.isFinite(a.published) ? a.published : 0
    return bTime - aTime
  })

  return videoList
}

/**
 * @param {string} rssString
 * @param {string} channelId
 */
export async function parseYouTubeRSSFeed(rssString, channelId) {
  // doesn't need to be asynchronous, but doing it allows us to do the relatively slow DOM querying in parallel
  try {
    const xmlDom = new DOMParser().parseFromString(rssString, 'application/xml')
    const channelName = xmlDom.querySelector('author > name').textContent
    const entries = xmlDom.querySelectorAll('entry')

    const promises = []

    for (const entry of entries) {
      promises.push(parseRSSEntry(entry, channelId, channelName))
    }

    return {
      name: channelName,
      videos: await Promise.all(promises)
    }
  } catch {
    return {
      videos: null
    }
  }
}

/**
 * @param {Element} entry
 * @param {string} channelId
 * @param {string} channelName
 */
async function parseRSSEntry(entry, channelId, channelName) {
  // doesn't need to be asynchronous, but doing it allows us to do the relatively slow DOM querying in parallel

  const rawViewCount = entry.getElementsByTagName('media:statistics')[0]?.getAttribute('views')

  let viewCount = null

  if (rawViewCount) {
    const parsedViewCount = parseInt(rawViewCount)

    if (!isNaN(parsedViewCount)) {
      viewCount = parsedViewCount
    }
  }

  // The channel-wide RSS feed mixes videos and shorts. Shorts have a
  // /shorts/VIDEOID href in the alternate link; regular videos (including
  // past livestreams, which become VODs) use /watch?v=VIDEOID.
  const alternateHref = entry.querySelector('link[rel="alternate"]')?.getAttribute('href') ?? ''
  const isShort = alternateHref.includes('/shorts/')

  return {
    authorId: channelId,
    author: channelName,
    // querySelector doesn't support xml namespaces so we have to use getElementsByTagName here
    videoId: entry.getElementsByTagName('yt:videoId')[0].textContent,
    title: entry.querySelector('title').textContent,
    published: Date.parse(entry.querySelector('published').textContent),
    viewCount,
    type: 'video',
    lengthSeconds: '0:00',
    isRSS: true,
    isShort
  }
}

/**
 * Fetch the channel-wide RSS feed and split it by content type.
 * Used as a fallback when YouTube's per-tab playlist feeds (UULF/UUSH/UULV)
 * return 404 — they've been unreliable since early 2026 while the
 * `channel_id=` feed remains functional.
 *
 * Note: live streams and VODs share the same `/watch?v=` URL in RSS, so
 * this helper cannot extract live streams separately. Callers for the Live
 * tab should not use this.
 *
 * @param {string} channelId
 * @param {'video' | 'short'} contentType
 * @param {(url: string, options?: object) => Promise<{ status: number, ok: boolean, text: string | (() => Promise<string>) }>} fetchFn
 * @returns {Promise<{ name?: string, videos: any[] | null, status: number }>}
 */
export async function fetchChannelFeedFiltered(channelId, contentType, fetchFn) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`

  const response = await fetchFn(feedUrl)

  if (!response.ok) {
    return { videos: null, status: response.status }
  }

  const text = typeof response.text === 'function' ? await response.text() : response.text
  const parsed = await parseYouTubeRSSFeed(text, channelId)

  if (parsed.videos == null) {
    return { videos: null, status: response.status }
  }

  const videos = parsed.videos.filter((video) => {
    if (contentType === 'short') {
      return video.isShort === true
    }
    return video.isShort !== true
  })

  return {
    name: parsed.name,
    videos,
    status: response.status
  }
}

/**
 * Fetch the channel-wide RSS feed and split it into videos + shorts in a
 * single HTTP round-trip. Preferred over two calls to fetchChannelFeedFiltered.
 *
 * @param {string} channelId
 * @param {(url: string, options?: object) => Promise<{ ok: boolean, status: number, text: string | (() => Promise<string>) }>} fetchFn
 * @returns {Promise<{ name?: string, videos: any[] | null, shorts: any[] | null, status: number }>}
 */
export async function fetchChannelFeedBothTypes(channelId, fetchFn) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`

  const response = await fetchFn(feedUrl)

  if (!response.ok) {
    return { videos: null, shorts: null, status: response.status }
  }

  const text = typeof response.text === 'function' ? await response.text() : response.text
  const parsed = await parseYouTubeRSSFeed(text, channelId)

  if (parsed.videos == null) {
    return { videos: null, shorts: null, status: response.status }
  }

  const videos = parsed.videos.filter((video) => video.isShort !== true)
  const shorts = parsed.videos.filter((video) => video.isShort === true)

  return {
    name: parsed.name,
    videos,
    shorts,
    status: response.status
  }
}
