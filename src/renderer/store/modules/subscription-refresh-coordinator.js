// Background subscription refresh coordinator.
//
// Keeps each subscribed channel's videos+shorts caches fresh without ever
// firing N fetches in parallel. Runs a worker loop that starts at most one
// fetch per tick, paces the ticks, and never re-fetches a channel while its
// cache is within TTL. Survives tab switches and page navs because it lives
// in the Vuex store singleton. Dies with renderer crashes (acceptable for v1
// — Plummer critique says prove it matters before moving to main process).
//
// Pacing phases:
//   cold-start: pool=6, inter-tick delay 200ms — burst the first pass to
//     populate a fresh cache quickly on install/first run.
//   steady:     pool=2, inter-tick delay 1500ms — survives YouTube's rate
//     limiter indefinitely.
// Transition to steady once every active-profile channel has been attempted
// at least once in this session.
//
// Strategy stickiness is kept in module-local Maps (not Vuex): surviving a
// Vuex hot-reload is unnecessary, and keeping these out of reactive state
// avoids mutation churn on every fetch.

import { fetchChannelAllContent } from '../../helpers/subscriptions-fetcher'

const TTL_MS = 30 * 60 * 1000 // don't re-fetch a channel within 30 min
const COLD_POOL = 6
const STEADY_POOL = 2
const COLD_DELAY_MS = 200
const STEADY_DELAY_MS = 1500
const IDLE_CHECK_MS = 60 * 1000 // when queue is empty, recheck every 60s
const BACKOFF_BASE_MS = 5 * 60 * 1000 // 5 min × 2^failures
const FETCH_TIMEOUT_MS = 30 * 1000 // give up on a single fetch after 30s

// Circuit breaker — when recent success rate drops below a threshold, pause
// the coordinator for a while. Prevents mass IP-flagging scenarios from
// spinning the worker forever.
const CIRCUIT_WINDOW = 20 // rolling result window
const CIRCUIT_MIN_SUCCESS_RATIO = 0.1 // <10% success = trip
const CIRCUIT_PAUSE_MS = 10 * 60 * 1000 // pause duration when tripped

// Log throttling — collapse per-channel failure spam into summary lines.
const FAILURE_LOG_SAMPLE = 25 // log one line per N failures
const FAILURE_LOG_INTERVAL_MS = 30_000 // or every 30s, whichever first

// --- Non-reactive internal state ---
// Kept out of Vuex on purpose: these fields change constantly and triggering
// Vuex mutations for each would drown the store in work.

/** Set of channelIds currently being fetched. */
const inFlight = new Set()
/** Map<channelId, number> of consecutive failure counts. */
const failureCounts = new Map()
/** Map<channelId, number> epoch-ms of earliest next attempt for that channel. */
const nextAllowedAt = new Map()
/** Map<channelId, 'channel-rss' | 'yt-dlp' | 'scraper'> sticky strategy per channel. */
const stickyStrategy = new Map()
/** Set of channelIds already attempted at least once this session. */
const attempted = new Set()
/** Set of channelIds the user has explicitly asked to refresh — bypasses
 *  the TTL and the auto-fetch-disabled gate. Cleared after a successful
 *  fetch for that channel. */
const forced = new Set()
/** Set of channelIds in the user-visible refresh batch. Bumped channels
 *  enter; channels exit on fetch completion (success OR failure). Drives
 *  the global progress bar so it reflects the user's pending refresh and
 *  not silent background TTL work. */
const currentBatch = new Set()
let currentBatchInitialSize = 0
/** Rolling window of recent fetch outcomes (true=success) for the circuit
 *  breaker. Length capped at CIRCUIT_WINDOW. */
const recentResults = []
/** Epoch-ms the circuit breaker tripped, or null. When set, the worker
 *  loop treats all channels as gated until CIRCUIT_PAUSE_MS has elapsed. */
let circuitTrippedAt = null
/** Failure-log throttle state. */
let failuresSinceLog = 0
let lastFailureLogAt = 0

let loopHandle = null
let stopFlag = false
let storeRef = null

const state = {
  running: false,
  phase: 'idle', // 'idle' | 'cold-start' | 'steady' | 'circuit-open'
  inFlightCount: 0,
  queueLength: 0,
  currentlyFetching: null,
  lastTickAt: null,
  // Exposed for UI diagnostics — the circuit trip time and recent success rate.
  circuitTrippedAt: null,
  recentSuccessRate: null
}

const getters = {
  getCoordinatorStatus: (s) => ({
    running: s.running,
    phase: s.phase,
    inFlightCount: s.inFlightCount,
    queueLength: s.queueLength,
    currentlyFetching: s.currentlyFetching,
    lastTickAt: s.lastTickAt,
    circuitTrippedAt: s.circuitTrippedAt,
    recentSuccessRate: s.recentSuccessRate
  })
}

const mutations = {
  setCoordinatorRunning(s, running) { s.running = running },
  setCoordinatorPhase(s, phase) { s.phase = phase },
  setCoordinatorInFlight(s, count) { s.inFlightCount = count },
  setCoordinatorQueueLength(s, n) { s.queueLength = n },
  setCoordinatorCurrentlyFetching(s, id) { s.currentlyFetching = id },
  setCoordinatorLastTick(s, t) { s.lastTickAt = t },
  setCoordinatorCircuitTrippedAt(s, t) { s.circuitTrippedAt = t },
  setCoordinatorRecentSuccessRate(s, r) { s.recentSuccessRate = r }
}

const actions = {
  startCoordinator({ commit }) {
    if (loopHandle) return
    stopFlag = false
    commit('setCoordinatorRunning', true)
    loopHandle = runLoop().catch((err) => {
      console.error('[coordinator] loop crashed', err)
      commit('setCoordinatorRunning', false)
      loopHandle = null
    })
  },

  stopCoordinator({ commit }) {
    stopFlag = true
    loopHandle = null
    commit('setCoordinatorRunning', false)
    commit('setCoordinatorPhase', 'idle')
  },

  bumpChannels(_ctx, channelIds) {
    // Force a refresh of these channels on the next due-list build.
    // Bypasses TTL and the auto-fetch-disabled gate; clears backoff.
    // Also enrolls them in the user-visible batch so the global progress
    // bar tracks their completion.
    if (!Array.isArray(channelIds)) return
    for (const id of channelIds) {
      nextAllowedAt.delete(id)
      failureCounts.delete(id)
      forced.add(id)
      currentBatch.add(id)
    }
    currentBatchInitialSize = Math.max(currentBatchInitialSize, currentBatch.size)
    publishProgress()
  },

  bumpActiveProfile() {
    const subs = storeRef?.getters?.getActiveProfile?.subscriptions
    if (!Array.isArray(subs)) return
    for (const s of subs) {
      nextAllowedAt.delete(s.id)
      failureCounts.delete(s.id)
    }
  }
}

// --- Worker loop ---

async function runLoop() {
  // eslint-disable-next-line no-unmodified-loop-condition -- stopFlag is mutated from the stopCoordinator action
  while (!stopFlag) {
    storeRef.commit('setCoordinatorLastTick', Date.now())

    // If the circuit breaker has tripped, skip all work and poll until the
    // pause elapses. YouTube is refusing us; hammering it accomplishes
    // nothing and accelerates IP flagging.
    if (isCircuitOpen()) {
      storeRef.commit('setCoordinatorPhase', 'circuit-open')
      storeRef.commit('setCoordinatorQueueLength', 0)
      await sleep(IDLE_CHECK_MS)
      continue
    }

    const snapshot = snapshotSubs()
    const dueList = buildDueList(snapshot)

    storeRef.commit('setCoordinatorQueueLength', dueList.length)

    // Cold-start phase ends once every active channel has been attempted.
    const isCold = snapshot.length > 0 && snapshot.some((s) => !attempted.has(s.id))
    const phase = dueList.length === 0
      ? 'idle'
      : isCold ? 'cold-start' : 'steady'
    storeRef.commit('setCoordinatorPhase', phase)

    if (dueList.length === 0) {
      await sleep(IDLE_CHECK_MS)
      continue
    }

    const poolSize = isCold ? COLD_POOL : STEADY_POOL
    const tickDelay = isCold ? COLD_DELAY_MS : STEADY_DELAY_MS

    // Wait for a slot.
    // eslint-disable-next-line no-unmodified-loop-condition -- stopFlag can flip from the stopCoordinator action in another tick
    while (!stopFlag && inFlight.size >= poolSize) {
      await sleep(100)
    }
    if (stopFlag) break

    const channel = dueList[0]
    if (inFlight.has(channel.id)) {
      // Already in flight (another loop iteration picked it up). Skip.
      await sleep(50)
      continue
    }

    inFlight.add(channel.id)
    storeRef.commit('setCoordinatorInFlight', inFlight.size)
    storeRef.commit('setCoordinatorCurrentlyFetching', channel.id)

    // Fire and forget. The promise resolves asynchronously and frees the slot.
    processChannel(channel).finally(() => {
      inFlight.delete(channel.id)
      storeRef.commit('setCoordinatorInFlight', inFlight.size)
    })

    await sleep(tickDelay)
  }
}

async function processChannel(channel) {
  const startedAt = Date.now()
  try {
    const result = await withTimeout(
      fetchChannelAllContent(channel.id, {
        preferStrategy: stickyStrategy.get(channel.id)
      }),
      FETCH_TIMEOUT_MS,
      channel.id
    )

    attempted.add(channel.id)

    if (result.strategy) {
      stickyStrategy.set(channel.id, result.strategy)
      failureCounts.delete(channel.id)
      nextAllowedAt.delete(channel.id)
      forced.delete(channel.id)
      recordResult(true)

      // Update caches — only for content types that returned non-null.
      if (result.videos != null) {
        await storeRef.dispatch('updateSubscriptionVideosCacheByChannel', {
          channelId: channel.id,
          videos: result.videos
        })
      }
      if (result.shorts != null) {
        await storeRef.dispatch('updateSubscriptionShortsCacheByChannel', {
          channelId: channel.id,
          videos: result.shorts
        })
      }
      if (result.name || result.thumbnailUrl) {
        storeRef.dispatch('batchUpdateSubscriptionDetails', [{
          channelId: channel.id,
          channelName: result.name,
          channelThumbnailUrl: result.thumbnailUrl
        }])
      }
    } else {
      // Everything failed. Schedule an exponential backoff for this channel
      // so we don't re-hit it on the next tick. Clear the force marker so
      // the backoff is actually honored — one bump gets one retry, not an
      // infinite loop of user-forced retries against a channel that's down.
      forced.delete(channel.id)
      const n = (failureCounts.get(channel.id) ?? 0) + 1
      failureCounts.set(channel.id, n)
      nextAllowedAt.set(channel.id, Date.now() + BACKOFF_BASE_MS * Math.pow(2, Math.min(n - 1, 5)))
      recordResult(false)
      logFailureThrottled(channel.id, n, result.status)
    }
  } catch (err) {
    forced.delete(channel.id)
    const n = (failureCounts.get(channel.id) ?? 0) + 1
    failureCounts.set(channel.id, n)
    nextAllowedAt.set(channel.id, Date.now() + BACKOFF_BASE_MS * Math.pow(2, Math.min(n - 1, 5)))
    recordResult(false)
    logFailureThrottled(channel.id, n, `thrown: ${err?.message ?? err}`)
  } finally {
    attempted.add(channel.id) // even on throw, consider the attempt made
    if (currentBatch.delete(channel.id)) {
      // This was a user-visible refresh; advance the progress bar.
      publishProgress()
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > 10_000) {
      console.warn(`[coordinator] slow fetch ${channel.id} took ${elapsedMs}ms`)
    }
  }
}

// --- Helpers ---

function snapshotSubs() {
  const profile = storeRef?.getters?.getActiveProfile
  return Array.isArray(profile?.subscriptions) ? profile.subscriptions : []
}

function buildDueList(subs) {
  if (!storeRef) return []
  const now = Date.now()
  const videoCache = storeRef.getters.getVideoCache
  const shortsCache = storeRef.getters.getShortsCache
  const autoFetch = storeRef.getters.getFetchSubscriptionsAutomatically

  const due = []
  for (const sub of subs) {
    if (inFlight.has(sub.id)) continue
    const next = nextAllowedAt.get(sub.id) ?? 0
    const isForced = forced.has(sub.id)

    // Respect the "auto-fetch subscriptions" setting. Forced bumps bypass it.
    if (!autoFetch && !isForced) continue
    if (next > now && !isForced) continue

    const vTs = toEpochMs(videoCache[sub.id]?.timestamp)
    const sTs = toEpochMs(shortsCache[sub.id]?.timestamp)
    const lastFetched = Math.max(vTs, sTs)
    const staleness = now - lastFetched
    if (!isForced && staleness < TTL_MS && attempted.has(sub.id)) continue

    due.push({ id: sub.id, staleness, isForced })
  }

  // Forced entries first (user asked for these NOW), then staler channels.
  due.sort((a, b) => {
    if (a.isForced !== b.isForced) return a.isForced ? -1 : 1
    return b.staleness - a.staleness
  })
  return due
}

// NeDB may hand back timestamps as ISO strings, numbers, or Date objects
// depending on serialization path. `new Date(aDateObject).getTime()` is NaN;
// this helper normalizes all three to epoch-ms.
function toEpochMs(timestamp) {
  if (timestamp == null) return 0
  if (typeof timestamp === 'number') return timestamp
  if (timestamp instanceof Date) return timestamp.getTime()
  const parsed = Date.parse(String(timestamp))
  return Number.isFinite(parsed) ? parsed : 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Drive the global progress bar (the same store mutations the old
// per-tab refresh code used) based on the user-visible batch state.
// Called whenever currentBatch changes size.
function publishProgress() {
  if (!storeRef) return
  if (currentBatch.size === 0) {
    storeRef.commit('setShowProgressBar', false)
    storeRef.commit('setProgressBarPercentage', 0)
    currentBatchInitialSize = 0
    return
  }
  const total = currentBatchInitialSize || currentBatch.size
  const done = total - currentBatch.size
  const pct = Math.max(0, Math.min(100, (done / total) * 100))
  storeRef.commit('setShowProgressBar', true)
  storeRef.commit('setProgressBarPercentage', pct)
}

// --- Circuit breaker + log throttle ---

function recordResult(success) {
  recentResults.push(success)
  if (recentResults.length > CIRCUIT_WINDOW) recentResults.shift()
  if (recentResults.length === CIRCUIT_WINDOW) {
    const successes = recentResults.filter(Boolean).length
    const rate = successes / CIRCUIT_WINDOW
    storeRef?.commit('setCoordinatorRecentSuccessRate', rate)
    if (rate < CIRCUIT_MIN_SUCCESS_RATIO && circuitTrippedAt == null) {
      circuitTrippedAt = Date.now()
      storeRef?.commit('setCoordinatorCircuitTrippedAt', circuitTrippedAt)
      console.warn(
        `[coordinator] circuit breaker tripped — ${successes}/${CIRCUIT_WINDOW} recent fetches succeeded; ` +
        `pausing for ${CIRCUIT_PAUSE_MS / 60000} min`
      )
    }
  }
}

function isCircuitOpen() {
  if (circuitTrippedAt == null) return false
  if (Date.now() - circuitTrippedAt >= CIRCUIT_PAUSE_MS) {
    console.warn('[coordinator] circuit breaker pause elapsed; resuming')
    circuitTrippedAt = null
    storeRef?.commit('setCoordinatorCircuitTrippedAt', null)
    recentResults.length = 0 // fresh window; don't re-trip instantly
    return false
  }
  return true
}

// Collapse the per-channel failure log into a summary line every N failures
// or every INTERVAL_MS, whichever comes first. Avoids DoS'ing the devtools
// console when hundreds of channels fail in a row.
function logFailureThrottled(channelId, attemptNumber, statusOrMessage) {
  failuresSinceLog++
  const now = Date.now()
  const intervalElapsed = now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS
  const sampleReached = failuresSinceLog >= FAILURE_LOG_SAMPLE
  if (lastFailureLogAt === 0 || intervalElapsed || sampleReached) {
    console.warn(
      `[coordinator] ${failuresSinceLog} recent failures ` +
      `(latest: ${channelId} attempt ${attemptNumber} ${statusOrMessage})`
    )
    failuresSinceLog = 0
    lastFailureLogAt = now
  }
}

// Racing against a timeout so a hung fetch can't permanently occupy a slot.
// The underlying fetch isn't cancelled (we don't have an AbortSignal threaded
// through youtubei.js here); but its slot is freed and the channel goes onto
// the backoff schedule.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[coordinator] fetch timeout after ${ms}ms for ${label}`))
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

// Bridge to set the store ref — called once from the module export.
// Also wires up a watcher on the active profile so that switching profiles
// re-enters cold-start pacing for the new profile's channels.
export function _bindStore(store) {
  storeRef = store

  let lastProfileId = null
  store.watch(
    (_s, g) => g.getActiveProfile?._id,
    (profileId) => {
      if (profileId === lastProfileId) return
      lastProfileId = profileId
      // Reset the per-channel "attempted this session" marker so the new
      // profile gets the cold-start burst (useful on fresh installs and
      // when switching to a profile with channels we haven't touched).
      attempted.clear()
      // Clear any failure backoffs so previously-failed channels get a
      // fresh chance under the new profile context.
      failureCounts.clear()
      nextAllowedAt.clear()
      forced.clear()
      // Drop any in-flight user-visible batch from the prior profile.
      currentBatch.clear()
      publishProgress()
    },
    { immediate: true }
  )
}

export default {
  state,
  getters,
  mutations,
  actions
}
