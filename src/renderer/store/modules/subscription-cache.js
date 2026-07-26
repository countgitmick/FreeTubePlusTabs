import {
  DBSubscriptionCacheHandlers,
} from '../../../datastores/handlers/index'

const state = {
  videoCache: {},
  liveCache: {},
  shortsCache: {},
  postsCache: {},

  subscriptionCacheReady: false,

  // Epoch-ms of the last time a refresh pass finished its work. Written by the
  // coordinator when its due list drains, and by the Live/Posts tabs when their
  // own remote refresh completes. Deliberately NOT derived from the per-channel
  // cache timestamps: those are only written on a *successful* fetch, so one
  // dead or backed-off channel pinned the "Feed Last Updated" widget to that
  // channel's last success no matter how often the user hit refresh.
  lastCompletedRefreshAt: null,
}

const getters = {
  getSubscriptionCacheReady: (state) => state.subscriptionCacheReady,

  /**
   * Epoch-ms for the "Feed Last Updated" widget, shared by all four
   * subscription tabs. Falls back to the newest cache write so a restart with a
   * warm cache — where nothing is due, so no pass runs — still shows a time
   * instead of a blank.
   */
  getLastCompletedRefreshAt: (state) => {
    if (state.lastCompletedRefreshAt != null) {
      return state.lastCompletedRefreshAt
    }

    let newest = null
    for (const cache of [state.videoCache, state.shortsCache, state.liveCache, state.postsCache]) {
      for (const entry of Object.values(cache)) {
        if (entry?.timestamp == null) continue
        const ts = new Date(entry.timestamp).getTime()
        if (Number.isFinite(ts) && (newest == null || ts > newest)) {
          newest = ts
        }
      }
    }
    return newest
  },

  getVideoCache: (state) => state.videoCache,

  getShortsCache: (state) => state.shortsCache,

  getLiveCache: (state) => state.liveCache,

  getPostsCache: (state) => state.postsCache,
}

const actions = {
  async grabAllSubscriptions({ commit, dispatch, rootGetters }) {
    try {
      const payload = await DBSubscriptionCacheHandlers.find()

      const videos = {}
      const liveStreams = {}
      const shorts = {}
      const communityPosts = {}

      const toBeRemovedChannelIds = []
      const subscribedChannelIdSet = rootGetters.getSubscribedChannelIdSet

      for (const dataEntry of payload) {
        const channelId = dataEntry._id
        if (!subscribedChannelIdSet.has(channelId)) {
          // Clean up cache data for unsubscribed channels
          toBeRemovedChannelIds.push(channelId)
          // No need to load data for unsubscribed channels
          continue
        }

        let hasData = false

        if (Array.isArray(dataEntry.videos)) {
          videos[channelId] = { videos: dataEntry.videos, timestamp: dataEntry.videosTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.liveStreams)) {
          liveStreams[channelId] = { videos: dataEntry.liveStreams, timestamp: dataEntry.liveStreamsTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.shorts)) {
          shorts[channelId] = { videos: dataEntry.shorts, timestamp: dataEntry.shortsTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.communityPosts)) {
          communityPosts[channelId] = { posts: dataEntry.communityPosts, timestamp: dataEntry.communityPostsTimestamp }
          hasData = true
        }

        if (!hasData) { toBeRemovedChannelIds.push(channelId) }
      }

      if (toBeRemovedChannelIds.length > 0) {
        // Delete channels with no data
        dispatch('clearSubscriptionsCacheForManyChannels', toBeRemovedChannelIds)
      }
      commit('setCaches', { videos, liveStreams, shorts, communityPosts })
      commit('setSubscriptionCacheReady', true)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionVideosCacheByChannel({ commit }, { channelId, videos, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateVideosByChannelId(channelId, videos, timestamp)
      commit('updateVideoCacheByChannel', { channelId, entries: videos, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionShortsCacheByChannel({ commit }, { channelId, videos, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateShortsByChannelId(channelId, videos, timestamp)
      commit('updateShortsCacheByChannel', { channelId, entries: videos, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionShortsCacheWithChannelPageShorts({ commit }, { channelId, videos }) {
    try {
      await DBSubscriptionCacheHandlers.updateShortsWithChannelPageShortsByChannelId(channelId, videos)
      commit('updateShortsCacheWithChannelPageShorts', { channelId, entries: videos })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionLiveCacheByChannel({ commit }, { channelId, videos, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateLiveStreamsByChannelId(channelId, videos, timestamp)
      commit('updateLiveCacheByChannel', { channelId, entries: videos, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionPostsCacheByChannel({ commit }, { channelId, posts, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateCommunityPostsByChannelId(channelId, posts, timestamp)
      commit('updatePostsCacheByChannel', { channelId, entries: posts, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async clearSubscriptionsCacheForManyChannels({ commit }, channelIds) {
    try {
      await DBSubscriptionCacheHandlers.deleteMultipleChannels(channelIds)
      commit('clearCachesForManyChannels', channelIds)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async clearSubscriptionsCache({ commit }) {
    try {
      await DBSubscriptionCacheHandlers.deleteAll()
      commit('clearCaches')
    } catch (errMessage) {
      console.error(errMessage)
    }
  },
}

const mutations = {
  setLastCompletedRefreshAt(state, timestamp) {
    state.lastCompletedRefreshAt = timestamp
  },
  updateVideoCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.videoCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.videoCache[channelId] = newObject
  },
  updateShortsCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.shortsCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.shortsCache[channelId] = newObject
  },
  updateShortsCacheWithChannelPageShorts(state, { channelId, entries }) {
    const cachedObject = state.shortsCache[channelId]

    if (cachedObject && cachedObject.videos.length > 0) {
      cachedObject.videos.forEach(cachedVideo => {
        const channelVideo = entries.find(short => cachedVideo.videoId === short.videoId)

        if (channelVideo) {
          // authorId probably never changes, so we don't need to update that

          cachedVideo.title = channelVideo.title
          cachedVideo.author = channelVideo.author

          // as the channel shorts page only has compact view counts for numbers above 1000 e.g. 12k
          // and the RSS feeds include an exact value, we only want to overwrite it when the number is larger than the cached value
          // 12345 vs 12000 => 12345
          // 12345 vs 15000 => 15000

          if (channelVideo.viewCount > cachedVideo.viewCount) {
            cachedVideo.viewCount = channelVideo.viewCount
          }
        }
      })
    }
  },
  updateLiveCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.liveCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.liveCache[channelId] = newObject
  },
  updatePostsCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.postsCache[channelId]
    const newObject = existingObject ?? { posts: null }
    if (entries != null) { newObject.posts = entries }
    newObject.timestamp = timestamp
    state.postsCache[channelId] = newObject
  },

  clearCaches(state) {
    state.videoCache = {}
    state.shortsCache = {}
    state.liveCache = {}
    state.postsCache = {}
  },

  clearCachesForManyChannels(state, channelIds) {
    channelIds.forEach((channelId) => {
      state.videoCache[channelId] = null
      state.liveCache[channelId] = null
      state.shortsCache[channelId] = null
      state.postsCache[channelId] = null
    })
  },

  setCaches(state, { videos, liveStreams, shorts, communityPosts }) {
    state.videoCache = videos
    state.liveCache = liveStreams
    state.shortsCache = shorts
    state.postsCache = communityPosts
  },

  setSubscriptionCacheReady(state, payload) {
    state.subscriptionCacheReady = payload
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
