<template>
  <component
    :is="resolvedComponent"
    v-if="resolvedComponent && initialized"
    v-show="alive"
  />
</template>

<script setup>
import { computed, nextTick, ref, watch, provide, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'

import store from '../../store/index'

/**
 * Module-level cache for resolved route components, keyed by path.
 * router.resolve() only runs once per unique path across all TabContent instances.
 */
const resolvedComponentCache = new Map()

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

// Idle hidden: component stays mounted in the DOM (v-show) but is visually hidden
// after the idle timeout. Child components should check isTabActive to skip work.
// This is visual hiding, not resource suspension — watchers/timers in children
// continue unless they guard on isTabActive.
const idleHidden = ref(false)

const alive = computed(() => !idleHidden.value)

let idleTimer = null

const resolvedComponent = computed(() => {
  const routePath = props.tab.route?.path
  if (!routePath) return null

  // Check module-level cache first — avoids calling router.resolve() on every
  // reactivity trigger. The cache is shared across all TabContent instances,
  // so each unique path is resolved at most once for the lifetime of the app.
  const cached = resolvedComponentCache.get(routePath)
  if (cached !== undefined) return cached

  try {
    const resolved = router.resolve({ path: routePath })
    if (resolved.matched.length > 0) {
      const component = resolved.matched[0].components.default
      resolvedComponentCache.set(routePath, component)
      return component
    }
  } catch (e) {
    console.error('Failed to resolve route:', routePath, e)
  }

  resolvedComponentCache.set(routePath, null)
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
    if (idleHidden.value) {
      idleHidden.value = false
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
    // Don't suspend if media is playing in this tab
    const tab = store.getters['tabs/getTabById'](props.tab.id)
    if (tab?.mediaPlaying) {
      startIdleTimer()
      return
    }
    idleHidden.value = true
  }, timeout * 1000)
}

// Handle tab refresh by re-mounting the inner component instead of relying
// on a key change in the parent (which caused Vue lifecycle race conditions)
watch(() => props.tab.refreshKey, () => {
  initialized.value = false
  nextTick(() => {
    initialized.value = true
    idleHidden.value = false
  })
})

onBeforeUnmount(() => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
})
</script>
