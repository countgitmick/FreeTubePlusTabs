// Unified per-channel fetcher used by the subscription refresh coordinator.
//
// Strategy ladder (per channel, per call):
//   1. Channel-wide RSS feed (channel_id=) — one request populates both
//      videos and shorts in a single parse. Cheapest and broadest.
//   2. yt-dlp sidecar — actively-maintained YouTube extractor; fallback
//      when RSS 404s (which it does on flagged IPs). Per-channel sticky
//      strategy promotes this once it's known to work.
//   3. Scraper /browse videos tab via youtubei.js — legacy fallback when
//      both RSS and yt-dlp fail. youtubei.js's extractor is updated more
//      slowly than yt-dlp, so this catches the rare case yt-dlp misses.
//
// Design notes:
// - The caller decides *when* to call this (rate-limiting is handled in the
//   coordinator via concurrency pool + inter-request delay). This helper
//   never sleeps; it just fetches or fails fast.
// - Returned shape is { videos, shorts, name, thumbnailUrl, strategy, status }.
//   Any of videos/shorts may be null to indicate "not available from this
//   strategy" (as opposed to [] meaning "no content this time").
// - Live streams and community posts are NOT fetched here. Those live on
//   their existing per-tab paths for now; the coordinator focuses on the
//   high-volume videos+shorts problem.

import { fetchChannelFeedBothTypes } from './subscriptions'
import { getLocalChannelVideos } from './api/local'
import { getYtdlpChannelVideos } from './api/yt-dlp'

/**
 * Fetch all content for a channel via the cheapest available strategy.
 * @param {string} channelId
 * @param {object} [options]
 * @param {'channel-rss' | 'yt-dlp' | 'scraper' | null} [options.preferStrategy]
 * @returns {Promise<{
 *   videos: any[] | null,
 *   shorts: any[] | null,
 *   name: string | null,
 *   thumbnailUrl: string | null,
 *   strategy: 'channel-rss' | 'yt-dlp' | 'scraper' | null,
 *   status: number
 * }>}
 */
export async function fetchChannelAllContent(channelId, options = {}) {
  const { preferStrategy } = options

  const order = orderForPreference(preferStrategy)

  let lastStatus = 0

  for (const strategy of order) {
    if (strategy === 'channel-rss') {
      const result = await tryChannelRss(channelId)
      lastStatus = result.status
      if (result.ok) {
        return wrapSuccess(result, 'channel-rss')
      }
      if (result.status === 404) {
        // RSS 404 alone doesn't prove the channel is gone (YouTube rotates
        // RSS aggressively). Fall through to other strategies.
        continue
      }
    } else if (strategy === 'yt-dlp') {
      const result = await tryYtdlp(channelId)
      if (result.unavailable) {
        // yt-dlp not installed — skip silently, don't waste a sticky
        // strategy slot on it.
        continue
      }
      lastStatus = result.status
      if (result.ok) {
        return wrapSuccess(result, 'yt-dlp')
      }
      if (result.status === 404) {
        return terminalFailure(404)
      }
    } else if (strategy === 'scraper') {
      const result = await tryScraper(channelId)
      lastStatus = result.status ?? lastStatus
      if (result.ok) {
        return wrapSuccess(result, 'scraper')
      }
      if (result.terminated) {
        return terminalFailure(404)
      }
    }
  }

  return {
    videos: null,
    shorts: null,
    name: null,
    thumbnailUrl: null,
    strategy: null,
    status: lastStatus
  }
}

function orderForPreference(preferStrategy) {
  switch (preferStrategy) {
    case 'scraper':
      return ['scraper', 'yt-dlp', 'channel-rss']
    case 'yt-dlp':
      return ['yt-dlp', 'channel-rss', 'scraper']
    default:
      return ['channel-rss', 'yt-dlp', 'scraper']
  }
}

function wrapSuccess(result, strategy) {
  return {
    videos: result.data.videos,
    shorts: result.data.shorts ?? null,
    name: result.data.name,
    thumbnailUrl: result.data.thumbnailUrl,
    strategy,
    status: result.status ?? 200
  }
}

function terminalFailure(status) {
  return {
    videos: null,
    shorts: null,
    name: null,
    thumbnailUrl: null,
    strategy: null,
    status
  }
}

async function tryChannelRss(channelId) {
  const fetchFn = process.env.IS_ELECTRON ? window.ftElectron.fetchUrl : fetch

  try {
    const parsed = await fetchChannelFeedBothTypes(channelId, fetchFn)
    if (parsed.status === 404) {
      return { ok: false, status: 404, data: null }
    }
    if (parsed.videos == null && parsed.shorts == null) {
      return { ok: false, status: parsed.status, data: null }
    }

    return {
      ok: true,
      status: parsed.status,
      data: {
        videos: parsed.videos,
        shorts: parsed.shorts,
        name: parsed.name ?? null,
        thumbnailUrl: null
      }
    }
  } catch (err) {
    console.error('[fetcher] channel-rss failed', channelId, err)
    return { ok: false, status: 0, data: null }
  }
}

async function tryYtdlp(channelId) {
  try {
    const outcome = await getYtdlpChannelVideos(channelId, 30)
    if (outcome.unavailable) {
      return { unavailable: true, ok: false, status: 0, data: null }
    }
    if (!outcome.ok) {
      return { unavailable: false, ok: false, status: outcome.status, data: null }
    }
    // yt-dlp's /videos listing can mix shorts in. parseYtdlpEntry classifies
    // each entry from its /shorts/ URL, so partition here: videos to the
    // videos cache, shorts to the shorts cache.
    //
    // Current yt-dlp serves this tab through YouTube's lockup renderer, which
    // gives every entry a /watch?v= URL — so nothing classifies as a short and
    // `shorts` comes out empty. That must stay null rather than [], because
    // null means "this strategy has nothing to say about shorts" while [] is a
    // wholesale replace: the coordinator's `result.shorts != null` guard would
    // let it through and blank the channel's shorts cache on disk. The channels
    // reaching yt-dlp are exactly the ones whose RSS feed failed, so their
    // cached shorts are the only copy left.
    const all = outcome.data.videos
    const shorts = all.filter((video) => video.isShort === true)
    return {
      unavailable: false,
      ok: true,
      status: 200,
      data: {
        videos: all.filter((video) => video.isShort !== true),
        shorts: shorts.length > 0 ? shorts : null,
        name: outcome.data.name,
        thumbnailUrl: outcome.data.thumbnailUrl
      }
    }
  } catch (err) {
    console.error('[fetcher] yt-dlp threw', channelId, err)
    return { unavailable: false, ok: false, status: 0, data: null }
  }
}

async function tryScraper(channelId) {
  if (!process.env.SUPPORTS_LOCAL_API) {
    return { ok: false, status: 0, data: null }
  }

  try {
    const result = await getLocalChannelVideos(channelId)
    if (result === null) {
      return { ok: false, status: 404, data: null, terminated: true }
    }
    // The scraper derives `published` from relative text ("3 weeks ago") via
    // calculatePublishedDate, i.e. `Date.now() - timeSpan` rounded to the
    // relative unit and anchored to fetch time. Flag these so the merged,
    // cross-channel sort can keep exact RSS/yt-dlp timestamps ahead of these
    // approximations instead of letting them interleave randomly.
    const videos = Array.isArray(result.videos)
      ? result.videos.map(video => ({ ...video, publishedApprox: true }))
      : null
    return {
      ok: true,
      status: 200,
      data: {
        videos,
        shorts: null,
        name: result.name ?? null,
        thumbnailUrl: result.thumbnailUrl ?? null
      }
    }
  } catch (err) {
    console.error('[fetcher] scraper failed', channelId, err)
    return { ok: false, status: 0, data: null }
  }
}
