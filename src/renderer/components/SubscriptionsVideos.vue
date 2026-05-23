<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :video-list="videoList"
    :error-channels="[]"
    :last-refresh-timestamp="lastVideoRefreshTimestamp"
    :attempted-fetch="attemptedFetch"
    :title="t('Global.Videos')"
    @refresh="handleRefresh"
  />
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from '../composables/use-i18n-polyfill'

import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../store/index'

import { getRelativeTimeFromDate } from '../helpers/utils'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../helpers/subscriptions'
import { useNow } from '../composables/use-now'

const { t } = useI18n()
const now = useNow()

/** @type {import('vue').ComputedRef<boolean>} */
const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

const activeSubscriptionList = computed(() => store.getters.getActiveProfile.subscriptions)

// The cache is the source of truth. The coordinator writes to it in the
// background; the view just renders whatever is currently cached. No more
// local shallowRef that can drift out of sync with the cache.
const cacheEntriesForAllActiveProfileChannels = computed(() => {
  const videoCache = store.getters.getVideoCache
  const entries = []
  for (const channel of activeSubscriptionList.value) {
    const cacheEntry = videoCache[channel.id]
    if (cacheEntry != null) {
      entries.push(cacheEntry)
    }
  }
  return entries
})

const videoList = computed(() => {
  const entries = cacheEntriesForAllActiveProfileChannels.value
  if (entries.length === 0) return []
  const all = entries.flatMap((entry) => entry.videos ?? [])
  return updateVideoListAfterProcessing(all)
})

const isQuickChecking = ref(false)

const isLoading = computed(() => !subscriptionCacheReady.value)

// Only true after the user manually refreshes in this session, so that the
// "Disabled Automatic Fetching" hint can show on fresh profiles with empty
// caches and auto-fetch turned off.
const attemptedFetch = ref(false)

const lastVideoRefreshTimestamp = computed(() => {
  // eslint-disable-next-line no-unused-expressions
  now.value // establish reactive dependency so this recomputes over time
  const entries = cacheEntriesForAllActiveProfileChannels.value
  if (entries.length === 0) return ''
  let minTs = null
  for (const entry of entries) {
    if (!entry.timestamp) continue
    const ts = new Date(entry.timestamp).getTime()
    if (!Number.isFinite(ts)) continue
    if (minTs == null || ts < minTs) minTs = ts
  }
  return minTs != null ? getRelativeTimeFromDate(minTs, true) : ''
})

async function handleRefresh() {
  if (isQuickChecking.value) return
  attemptedFetch.value = true
  const channelIds = activeSubscriptionList.value.map((s) => s.id)
  if (channelIds.length === 0) return

  isQuickChecking.value = true
  try {
    await Promise.allSettled(channelIds.map(async (channelId) => {
      try {
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
        if (!res.ok) return
        const text = await res.text()
        const { videos } = await parseYouTubeRSSFeed(text, channelId)
        if (!Array.isArray(videos) || videos.length === 0) return

        const cached = store.getters.getVideoCache[channelId]?.videos ?? []
        const cachedIds = new Set(cached.map(v => v.videoId))
        const newVideos = videos.filter(v => v.videoId && !cachedIds.has(v.videoId))
        if (newVideos.length === 0) return

        const merged = [...newVideos, ...cached]
        await store.dispatch('updateSubscriptionVideosCacheByChannel', { channelId, videos: merged })
      } catch {
        // silently skip failed channels
      }
    }))
  } finally {
    isQuickChecking.value = false
  }

  store.dispatch('bumpChannels', channelIds)
}
</script>
