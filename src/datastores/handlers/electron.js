import { DBActions } from '../../constants'

const IPC_TIMEOUT = 10_000

/**
 * Wraps an IPC promise with a timeout to prevent UI freeze if the main process hangs.
 * @param {Promise} promise
 * @returns {Promise}
 */
function withTimeout(promise) {
  let timeoutId
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`IPC call timed out after ${IPC_TIMEOUT}ms`))
    }, IPC_TIMEOUT)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

/**
 * Unified IPC call: strips Vue reactive Proxies via JSON round-trip,
 * then applies timeout. All data crossing the IPC boundary goes through here.
 *
 * The try/catch is load-bearing: without it, webpack's terser minifier
 * eliminates JSON.parse(JSON.stringify(x)) as an identity no-op, which
 * leaves Vue Proxies intact and causes DataCloneError at the context bridge.
 *
 * @param {Function} channel - window.ftElectron.dbXxx method
 * @param {string} action - DBActions constant
 * @param {*} [data] - payload (may contain Vue reactive Proxies)
 * @returns {Promise}
 */
function dbCall(channel, action, data) {
  let clean = data
  if (data != null && typeof data === 'object') {
    try {
      clean = JSON.parse(JSON.stringify(data))
    } catch {
      // JSON.stringify can fail on circular refs or BigInt.
      // Fall through with original data — IPC will throw
      // DataCloneError, which callers already handle.
    }
  }
  return withTimeout(channel(action, clean))
}

class Settings {
  static find() {
    return dbCall(window.ftElectron.dbSettings, DBActions.GENERAL.FIND)
  }

  static upsert(_id, value) {
    return dbCall(window.ftElectron.dbSettings, DBActions.GENERAL.UPSERT, { _id, value })
  }
}

class History {
  static find() {
    return dbCall(window.ftElectron.dbHistory, DBActions.GENERAL.FIND)
  }

  static upsert(record) {
    return dbCall(window.ftElectron.dbHistory, DBActions.GENERAL.UPSERT, record)
  }

  static overwrite(records) {
    return dbCall(window.ftElectron.dbHistory, DBActions.GENERAL.OVERWRITE, records)
  }

  static updateWatchProgress(videoId, watchProgress) {
    return dbCall(window.ftElectron.dbHistory, DBActions.HISTORY.UPDATE_WATCH_PROGRESS, { videoId, watchProgress })
  }

  static updateLastViewedPlaylist(videoId, lastViewedPlaylistId, lastViewedPlaylistType, lastViewedPlaylistItemId) {
    return dbCall(window.ftElectron.dbHistory, DBActions.HISTORY.UPDATE_PLAYLIST, { videoId, lastViewedPlaylistId, lastViewedPlaylistType, lastViewedPlaylistItemId })
  }

  static delete(videoId) {
    return dbCall(window.ftElectron.dbHistory, DBActions.GENERAL.DELETE, videoId)
  }

  static deleteOlderThan(seconds) {
    return window.ftElectron.dbHistory(DBActions.HISTORY.DELETE_WATCH_HISTORY_OLDER_THAN, seconds)
  }

  static deleteAll() {
    return dbCall(window.ftElectron.dbHistory, DBActions.GENERAL.DELETE_ALL)
  }
}

class Profiles {
  static create(profile) {
    return dbCall(window.ftElectron.dbProfiles, DBActions.GENERAL.CREATE, profile)
  }

  static find() {
    return dbCall(window.ftElectron.dbProfiles, DBActions.GENERAL.FIND)
  }

  static upsert(profile) {
    return dbCall(window.ftElectron.dbProfiles, DBActions.GENERAL.UPSERT, profile)
  }

  static addChannelToProfiles(channel, profileIds) {
    return dbCall(window.ftElectron.dbProfiles, DBActions.PROFILES.ADD_CHANNEL, { channel, profileIds })
  }

  static removeChannelFromProfiles(channelId, profileIds) {
    return dbCall(window.ftElectron.dbProfiles, DBActions.PROFILES.REMOVE_CHANNEL, { channelId, profileIds })
  }

  static delete(id) {
    return dbCall(window.ftElectron.dbProfiles, DBActions.GENERAL.DELETE, id)
  }
}

class Playlists {
  static create(playlists) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.CREATE, playlists)
  }

  static find() {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.FIND)
  }

  static upsert(playlist) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.UPSERT, playlist)
  }

  static upsertVideoByPlaylistId(_id, lastUpdatedAt, videoData) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.PLAYLISTS.UPSERT_VIDEO, { _id, lastUpdatedAt, videoData })
  }

  static upsertVideosByPlaylistId(_id, lastUpdatedAt, videos) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.PLAYLISTS.UPSERT_VIDEOS, { _id, lastUpdatedAt, videos })
  }

  static delete(_id) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.DELETE, _id)
  }

  static deleteVideoIdByPlaylistId(_id, lastUpdatedAt, videoId, playlistItemId) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.PLAYLISTS.DELETE_VIDEO_ID, { _id, lastUpdatedAt, videoId, playlistItemId })
  }

  static deleteVideoIdsByPlaylistId(_id, lastUpdatedAt, playlistItemIds) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.PLAYLISTS.DELETE_VIDEO_IDS, { _id, lastUpdatedAt, playlistItemIds })
  }

  static deleteAllVideosByPlaylistId(_id) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.PLAYLISTS.DELETE_ALL_VIDEOS, _id)
  }

  static deleteMultiple(ids) {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.DELETE_MULTIPLE, ids)
  }

  static deleteAll() {
    return dbCall(window.ftElectron.dbPlaylists, DBActions.GENERAL.DELETE_ALL)
  }
}

class SearchHistory {
  static find() {
    return dbCall(window.ftElectron.dbSearchHistory, DBActions.GENERAL.FIND)
  }

  static deleteOlderThan(seconds) {
    return window.ftElectron.dbSearchHistory(DBActions.HISTORY.DELETE_SEARCH_HISTORY_OLDER_THAN, seconds)
  }

  static upsert(searchHistoryEntry) {
    return dbCall(window.ftElectron.dbSearchHistory, DBActions.GENERAL.UPSERT, searchHistoryEntry)
  }

  static overwrite(records) {
    return dbCall(window.ftElectron.dbSearchHistory, DBActions.GENERAL.OVERWRITE, records)
  }

  static delete(_id) {
    return dbCall(window.ftElectron.dbSearchHistory, DBActions.GENERAL.DELETE, _id)
  }

  static deleteAll() {
    return dbCall(window.ftElectron.dbSearchHistory, DBActions.GENERAL.DELETE_ALL)
  }
}

class SubscriptionCache {
  static find() {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.GENERAL.FIND)
  }

  static updateVideosByChannelId(channelId, entries, timestamp) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.SUBSCRIPTION_CACHE.UPDATE_VIDEOS_BY_CHANNEL, { channelId, entries, timestamp })
  }

  static updateLiveStreamsByChannelId(channelId, entries, timestamp) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.SUBSCRIPTION_CACHE.UPDATE_LIVE_STREAMS_BY_CHANNEL, { channelId, entries, timestamp })
  }

  static updateShortsByChannelId(channelId, entries, timestamp) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.SUBSCRIPTION_CACHE.UPDATE_SHORTS_BY_CHANNEL, { channelId, entries, timestamp })
  }

  static updateShortsWithChannelPageShortsByChannelId(channelId, entries) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.SUBSCRIPTION_CACHE.UPDATE_SHORTS_WITH_CHANNEL_PAGE_SHORTS_BY_CHANNEL, { channelId, entries })
  }

  static updateCommunityPostsByChannelId(channelId, entries, timestamp) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.SUBSCRIPTION_CACHE.UPDATE_COMMUNITY_POSTS_BY_CHANNEL, { channelId, entries, timestamp })
  }

  static deleteMultipleChannels(channelIds) {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.GENERAL.DELETE_MULTIPLE, channelIds)
  }

  static deleteAll() {
    return dbCall(window.ftElectron.dbSubscriptionCache, DBActions.GENERAL.DELETE_ALL)
  }
}

class Tabs {
  static find() {
    return dbCall(window.ftElectron.dbTabs, DBActions.GENERAL.FIND)
  }

  static upsert(data) {
    return dbCall(window.ftElectron.dbTabs, DBActions.GENERAL.UPSERT, data)
  }

  static deleteAll() {
    return dbCall(window.ftElectron.dbTabs, DBActions.GENERAL.DELETE_ALL)
  }
}

export {
  Settings as settings,
  History as history,
  Profiles as profiles,
  Playlists as playlists,
  SearchHistory as searchHistory,
  SubscriptionCache as subscriptionCache,
  Tabs as tabs,
}
