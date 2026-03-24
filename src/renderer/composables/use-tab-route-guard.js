import store from '../store/index'

/**
 * Returns a function that checks whether a route change should be skipped
 * because it was triggered by a tab switch, not actual user navigation.
 *
 * @param {import('vue').Ref<boolean>} isTabActive - Injected ref indicating whether this tab is active
 * @returns {{ shouldSkipRouteChange: () => boolean }}
 */
export function useTabRouteGuard(isTabActive) {
  function shouldSkipRouteChange() {
    if (store.getters['tabs/getTabSwitchNavCount'] > 0) return true
    if (!isTabActive.value) return true
    return false
  }

  return { shouldSkipRouteChange }
}
