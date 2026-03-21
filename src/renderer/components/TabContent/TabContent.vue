<template>
  <component
    :is="resolvedComponent"
    v-if="resolvedComponent && alive"
  />
</template>

<script setup>
import { computed, ref, watch, provide, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'

import store from '../../store/index'

const props = defineProps({
  tab: {
    type: Object,
    required: true
  }
})

const router = useRouter()

const activeTabId = computed(() => store.getters['tabs/getActiveTabId'])
const isActive = computed(() => props.tab.id === activeTabId.value)

// Provide tab context to child components so they can guard route watchers
provide('tabId', props.tab.id)
provide('isTabActive', isActive)

// Lazy initialization: only mount content once the tab has been activated.
// This ensures $route is correct when the component first initializes,
// since we sync the router to the active tab's route before setting activeTabId.
const initialized = ref(isActive.value)
const idleDestroyed = ref(false)

const alive = computed(() => initialized.value && !idleDestroyed.value)

let idleTimer = null

const resolvedComponent = computed(() => {
  const routePath = props.tab.route?.path
  if (!routePath) return null
  try {
    const resolved = router.resolve({ path: routePath, query: props.tab.route.query || {} })
    if (resolved.matched.length > 0) {
      return resolved.matched[0].components.default
    }
  } catch {
    // Invalid route path, return null
  }
  return null
})

watch(isActive, (active) => {
  if (active) {
    // Tab became active — clear idle timer, revive if needed
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!initialized.value) {
      initialized.value = true
    }
    if (idleDestroyed.value) {
      idleDestroyed.value = false
    }
  } else {
    // Tab became inactive — start idle timer
    startIdleTimer()
  }
})

function startIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  const timeout = store.getters.getPlayerIdleTimeout
  if (!timeout || timeout <= 0) return

  idleTimer = setTimeout(() => {
    // Don't destroy if media is playing in this tab
    const tab = store.getters['tabs/getTabById'](props.tab.id)
    if (tab?.mediaPlaying) {
      startIdleTimer()
      return
    }
    idleDestroyed.value = true
  }, timeout * 1000)
}

onBeforeUnmount(() => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
})
</script>
