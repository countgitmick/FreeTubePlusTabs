import store from '../store/index'
import { copyToClipboard, showToast } from '../helpers/utils'
import { useI18n } from './use-i18n-polyfill'

/**
 * Shows an error toast with a copy-to-clipboard handler, matching the
 * pattern used throughout the codebase.
 * @param {string} label - Pre-translated error label
 * @param {any} err
 */
function showErrorToast(label, err) {
  showToast(`${label}: ${err}`, 10000, () => {
    copyToClipboard(err)
  })
}

/**
 * Attempts localFn first; on failure, falls back to invidiousFn if allowed.
 * @param {(s: string) => string} t - i18n translate function
 * @param {() => Promise<any>} localFn
 * @param {() => Promise<any>} invidiousFn
 * @param {boolean} canFallback
 * @param {((err: any) => boolean)|undefined} shouldFallback
 * @returns {Promise<any>}
 */
async function tryLocalFirst(t, localFn, invidiousFn, canFallback, shouldFallback) {
  try {
    return await localFn()
  } catch (localErr) {
    console.error(localErr)
    showErrorToast(t('Local API Error (Click to copy)'), localErr)

    if (canFallback && (!shouldFallback || shouldFallback(localErr))) {
      showToast(t('Falling back to Invidious API'))
      try {
        return await invidiousFn()
      } catch (invidiousErr) {
        console.error(invidiousErr)
        showErrorToast(t('Invidious API Error (Click to copy)'), invidiousErr)
        throw invidiousErr
      }
    }

    throw localErr
  }
}

/**
 * Attempts invidiousFn first; on failure, falls back to localFn if allowed.
 * @param {(s: string) => string} t - i18n translate function
 * @param {() => Promise<any>} localFn
 * @param {() => Promise<any>} invidiousFn
 * @param {boolean} canFallback
 * @param {((err: any) => boolean)|undefined} shouldFallback
 * @returns {Promise<any>}
 */
async function tryInvidiousFirst(t, localFn, invidiousFn, canFallback, shouldFallback) {
  try {
    return await invidiousFn()
  } catch (invidiousErr) {
    console.error(invidiousErr)
    showErrorToast(t('Invidious API Error (Click to copy)'), invidiousErr)

    if (canFallback && (!shouldFallback || shouldFallback(invidiousErr))) {
      showToast(t('Falling back to Local API'))
      try {
        return await localFn()
      } catch (localErr) {
        console.error(localErr)
        showErrorToast(t('Local API Error (Click to copy)'), localErr)
        throw localErr
      }
    }

    throw invidiousErr
  }
}

/**
 * Factory that creates the backend fetch logic without depending on
 * Vue Composition API context. Use this in Options API components
 * by passing `this.$t.bind(this)`.
 *
 * @param {(s: string) => string} t - i18n translate function
 * @returns {{ backendFetch: (localFn: () => Promise<any>, invidiousFn: () => Promise<any>, options?: { shouldFallback?: (err: any) => boolean }) => Promise<any> }}
 */
export function createBackendFetch(t) {
  /**
   * Runs the primary API function based on the user's backend preference.
   * If the primary call fails AND backendFallback is enabled, shows a toast
   * and transparently retries with the other backend.
   *
   * @param {() => Promise<any>} localFn  - Calls the Local API (youtubei.js)
   * @param {() => Promise<any>} invidiousFn - Calls the Invidious REST API
   * @param {{ shouldFallback?: (err: any) => boolean }} [options]
   * @returns {Promise<any>} Result from whichever backend succeeded
   */
  async function backendFetch(localFn, invidiousFn, { shouldFallback } = {}) {
    const backendPreference = store.getters.getBackendPreference
    const backendFallback = store.getters.getBackendFallback

    if (!process.env.SUPPORTS_LOCAL_API || backendPreference === 'invidious') {
      return await tryInvidiousFirst(
        t,
        localFn,
        invidiousFn,
        process.env.SUPPORTS_LOCAL_API && backendFallback,
        shouldFallback,
      )
    }

    return await tryLocalFirst(t, localFn, invidiousFn, backendFallback, shouldFallback)
  }

  return { backendFetch }
}

/**
 * Composable that unifies the backend preference check and fallback logic.
 * For Composition API components (script setup / setup()).
 */
export function useBackendFetch() {
  const { t } = useI18n()
  return createBackendFetch(t)
}
