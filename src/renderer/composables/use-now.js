import { ref, onBeforeUnmount } from 'vue'

/**
 * Singleton reactive time stream. One timer shared by all consumers,
 * reference-counted so it starts on first mount and stops on last unmount.
 * Use as a dependency in computed properties that derive relative timestamps.
 */

const INTERVAL = 30_000
const now = ref(Date.now())
let consumerCount = 0
let timer = null

function tick() { now.value = Date.now() }

export function useNow() {
  if (++consumerCount === 1) {
    timer = setInterval(tick, INTERVAL)
  }
  onBeforeUnmount(() => {
    if (--consumerCount === 0) {
      clearInterval(timer)
      timer = null
    }
  })
  return now
}
