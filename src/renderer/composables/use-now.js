import { ref, onBeforeUnmount } from 'vue'

/**
 * Reactive current-time stream. Returns a ref that ticks every `interval` ms.
 * Use as a dependency in computed properties that derive relative timestamps.
 * @param {number} interval - tick interval in milliseconds (default 30s)
 */
export function useNow(interval = 30_000) {
  const now = ref(Date.now())
  const timer = setInterval(() => { now.value = Date.now() }, interval)
  onBeforeUnmount(() => clearInterval(timer))
  return now
}
