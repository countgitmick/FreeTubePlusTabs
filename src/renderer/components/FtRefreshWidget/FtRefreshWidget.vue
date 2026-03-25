<template>
  <Teleport
    to="#topnav-refresh-target"
    :disabled="!isTabActive"
    defer
  >
    <div
      class="refreshSection"
    >
      <p
        v-if="lastRefreshTimestamp"
        class="lastRefreshTimestamp"
        :title="t('Feed.Feed Last Updated', { feedName: title, date: lastRefreshTimestamp })"
      >
        {{ lastRefreshTimestamp }}
      </p>
      <FtIconButton
        :disabled="disableRefresh"
        :icon="['fas', 'sync']"
        class="refreshButton"
        :title="refreshFeedButtonTitle"
        :size="20"
        :theme="null"
        :use-shadow="false"
        @click="click"
      />
    </div>
  </Teleport>
</template>

<script setup>
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../composables/use-i18n-polyfill'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import { KeyboardShortcuts } from '../../../constants'
import { addKeyboardShortcutToActionTitle } from '../../helpers/utils'

const props = defineProps({
  disableRefresh: {
    type: Boolean,
    default: false
  },
  lastRefreshTimestamp: {
    type: String,
    default: ''
  },
  title: {
    type: String,
    required: true
  }
})

const { t } = useI18n()

const isTabActive = inject('isTabActive', ref(true))

const refreshFeedButtonTitle = computed(() => {
  return addKeyboardShortcutToActionTitle(
    t('Feed.Refresh Feed', { subscriptionName: props.title }),
    KeyboardShortcuts.APP.SITUATIONAL.REFRESH
  )
})

const emit = defineEmits(['click'])

function click() {
  emit('click')
}
</script>
