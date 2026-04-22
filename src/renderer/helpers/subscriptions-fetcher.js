// Unified per-channel fetcher used by the subscription refresh coordinator.
//
// Strategy ladder (per channel, per call):
//   1. Channel-wide RSS feed (channel_id=) — one request populates both
//      videos and shorts in a single parse. Cheapest and broadest.
//   2. Scraper /browse videos tab — fallback when RSS is 404/rate-limited
//      or when the feed parser produces nothing usable.
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

/**
 * Fetch all content for a channel via the cheapest available strategy.
 * @param {string} channelId
 * @param {object} [options]
 * @param {'channel-rss' | 'scraper' | null} [options.preferStrategy]
 * @returns {Promise<{
 *   videos: any[] | null,
 *   shorts: any[] | null,
 *   name: string | null,
 *   thumbnailUrl: string | null,
 *   strategy: 'channel-rss' | 'scraper' | null,
 *   status: number
 * }>}
 */
export async function fetchChannelAllContent(channelId, options = {}) {
  const { preferStrategy } = options

  const order = preferStrategy === 'scraper'
    ? ['scraper', 'channel-rss']
    : ['channel-rss', 'scraper']

  let lastStatus = 0

  for (const strategy of order) {
    if (strategy === 'channel-rss') {
      const result = await tryChannelRss(channelId)
      lastStatus = result.status
      if (result.ok) {
        return {
          videos: result.data.videos,
          shorts: result.data.shorts,
          name: result.data.name,
          thumbnailUrl: result.data.thumbnailUrl,
          strategy: 'channel-rss',
          status: result.status
        }
      }
      if (result.status === 404) {
        return {
          videos: null,
          shorts: null,
          name: null,
          thumbnailUrl: null,
          strategy: null,
          status: 404
        }
      }
    } else if (strategy === 'scraper') {
      const result = await tryScraper(channelId)
      lastStatus = result.status ?? lastStatus
      if (result.ok) {
        return {
          videos: result.data.videos,
          shorts: result.data.shorts,
          name: result.data.name,
          thumbnailUrl: result.data.thumbnailUrl,
          strategy: 'scraper',
          status: result.status ?? 200
        }
      }
      if (result.terminated) {
        return {
          videos: null,
          shorts: null,
          name: null,
          thumbnailUrl: null,
          strategy: null,
          status: 404
        }
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

async function tryScraper(channelId) {
  if (!process.env.SUPPORTS_LOCAL_API) {
    return { ok: false, status: 0, data: null }
  }

  try {
    const result = await getLocalChannelVideos(channelId)
    if (result === null) {
      return { ok: false, status: 404, data: null, terminated: true }
    }
    return {
      ok: true,
      status: 200,
      data: {
        videos: Array.isArray(result.videos) ? result.videos : null,
        // Scraper tab=videos doesn't include shorts. Leave null so we don't
        // overwrite a good shorts cache with garbage.
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
