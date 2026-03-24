import store from '../store/index'
import { copyToClipboard, showToast } from '../helpers/utils'
import { useI18n } from './use-i18n-polyfill'

/**
 * Composable that unifies the backend preference check and fallback logic
 * that was previously duplicated across ~25 data-loading views.
 *
 * Each view still owns its individual `getXxxLocal()` and `getXxxInvidious()`
 * functions. This composable only abstracts the preference routing and
 * try/catch-with-fallback wrapper.
 */
export function useBackendFetch() {
  const { t } = useI18n()

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
   * @param {() => Promise<any>} localFn
   * @param {() => Promise<any>} invidiousFn
   * @param {boolean} canFallback
   * @returns {Promise<any>}
   */
  async function tryLocalFirst(localFn, invidiousFn, canFallback) {
    try {
      return await localFn()
    } catch (localErr) {
      console.error(localErr)
      showErrorToast(t('Local API Error (Click to copy)'), localErr)

      if (canFallback) {
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
   * @param {() => Promise<any>} localFn
   * @param {() => Promise<any>} invidiousFn
   * @param {boolean} canFallback
   * @returns {Promise<any>}
   */
  async function tryInvidiousFirst(localFn, invidiousFn, canFallback) {
    try {
      return await invidiousFn()
    } catch (invidiousErr) {
      console.error(invidiousErr)
      showErrorToast(t('Invidious API Error (Click to copy)'), invidiousErr)

      if (canFallback) {
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
   * Runs the primary API function based on the user's backend preference.
   * If the primary call fails AND backendFallback is enabled, shows a toast
   * and transparently retries with the other backend.
   *
   * @param {() => Promise<any>} localFn  - Calls the Local API (youtubei.js)
   * @param {() => Promise<any>} invidiousFn - Calls the Invidious REST API
   * @returns {Promise<any>} Result from whichever backend succeeded
   */
  async function backendFetch(localFn, invidiousFn) {
    const backendPreference = store.getters.getBackendPreference
    const backendFallback = store.getters.getBackendFallback

    if (!process.env.SUPPORTS_LOCAL_API || backendPreference === 'invidious') {
      return await tryInvidiousFirst(
        localFn,
        invidiousFn,
        process.env.SUPPORTS_LOCAL_API && backendFallback,
      )
    }

    return await tryLocalFirst(localFn, invidiousFn, backendFallback)
  }

  return { backendFetch }
}
