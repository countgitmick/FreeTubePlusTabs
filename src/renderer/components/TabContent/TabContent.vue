<template>
  <component
    :is="resolvedComponent"
    v-if="resolvedComponent && initialized && !suspended"
    v-show="isActive"
  />
</template>

<script setup>
import { computed, nextTick, ref, watch, provide, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'

import store from '../../store/index'

/**
 * Module-level LRU cache for resolved route components, keyed by path.
 * router.resolve() only runs once per unique path across all TabContent instances.
 *
 * Bounded so a long-running session that visits many unique /watch/:id paths
 * doesn't accumulate Map entries forever. 50 is well above the 14 distinct
 * router-record count and covers any realistic working set of recently-visited
 * video / channel / playlist IDs.
 */
const RESOLVED_COMPONENT_CACHE_MAX = 50
const resolvedComponentCache = new Map()

function cacheResolvedComponent(routePath, component) {
  // Refresh recency by deleting before set (Map iteration order is insertion order)
  if (resolvedComponentCache.has(routePath)) {
    resolvedComponentCache.delete(routePath)
  } else if (resolvedComponentCache.size >= RESOLVED_COMPONENT_CACHE_MAX) {
    // Evict oldest entry
    const oldestKey = resolvedComponentCache.keys().next().value
    resolvedComponentCache.delete(oldestKey)
  }
  resolvedComponentCache.set(routePath, component)
}

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

// Suspended: when the idle timer expires for a non-active tab, the inner
// component is fully unmounted via v-if. This destroys Shaka, aborts pending
// fetches, clears watchers and timers — actual resource suspension, not
// just display:none. On revival the component remounts from props.tab.route
// (which is preserved in Vuex), with a brief reload cost the user implicitly
// accepted by enabling the idle timeout in settings.
const suspended = ref(false)

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
      cacheResolvedComponent(routePath, component)
      return component
    }
  } catch (e) {
    console.error('Failed to resolve route:', routePath, e)
  }

  cacheResolvedComponent(routePath, null)
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
    if (suspended.value) {
      // Revive: re-mount the inner component. The route is still in props.tab.route,
      // so the page will re-fetch and re-render from a clean slate.
      suspended.value = false
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
    // Real teardown: v-if=false unmounts the inner component, which fires
    // its onBeforeUnmount chain (Shaka destroy, fetch aborts, listener removal).
    suspended.value = true
  }, timeout * 1000)
}

// Handle tab refresh by re-mounting the inner component instead of relying
// on a key change in the parent (which caused Vue lifecycle race conditions)
watch(() => props.tab.refreshKey, () => {
  initialized.value = false
  suspended.value = false
  nextTick(() => {
    initialized.value = true
  })
})

onBeforeUnmount(() => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
})
</script>
