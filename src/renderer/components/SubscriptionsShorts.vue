<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :video-list="videoList"
    :error-channels="[]"
    :attempted-fetch="attemptedFetch"
    :last-refresh-timestamp="lastShortRefreshTimestamp"
    :title="t('Global.Shorts')"
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

const cacheEntriesForAllActiveProfileChannels = computed(() => {
  const shortsCache = store.getters.getShortsCache
  const entries = []
  for (const channel of activeSubscriptionList.value) {
    const cacheEntry = shortsCache[channel.id]
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

const attemptedFetch = ref(false)

const lastShortRefreshTimestamp = computed(() => {
  // eslint-disable-next-line no-unused-expressions
  now.value
  const ts = store.getters.getLastCompletedRefreshAt
  return ts != null ? getRelativeTimeFromDate(ts, true) : ''
})

function handleRefresh() {
  attemptedFetch.value = true
  const channelIds = activeSubscriptionList.value.map((s) => s.id)
  if (channelIds.length === 0) return
  store.dispatch('bumpChannels', channelIds)
}
</script>
