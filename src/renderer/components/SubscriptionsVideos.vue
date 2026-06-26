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
import { updateVideoListAfterProcessing } from '../helpers/subscriptions'
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

function handleRefresh() {
  // The coordinator owns fetching and cache writes. The view only asks for a
  // refresh; bumping enrolls the channels in the user-visible batch (drives the
  // progress bar) and bypasses TTL/backoff. Doing the fetch+merge here as well
  // would double-fetch every channel and then get overwritten by the
  // coordinator's wholesale cache replace — see SubscriptionsShorts.vue.
  attemptedFetch.value = true
  const channelIds = activeSubscriptionList.value.map((s) => s.id)
  if (channelIds.length === 0) return
  store.dispatch('bumpChannels', channelIds)
}
</script>
