/* eslint-disable @intlify/vue-i18n/no-dynamic-keys */
import { computed } from 'vue'

import i18n from '../i18n/index'

/**
 * Polyfill for vue-i18n's useI18n composable that wraps the global i18n instance.
 * Provides a computed `locale` and the global `t` function for use in composables.
 */
export function useI18n() {
  const locale = computed({
    get() {
      return i18n.global.locale.value
    },
    set(locale) {
      i18n.global.locale.value = locale
    }
  })

  return {
    locale,
    t
  }
}

/**
 * @overload
 * @param {string} key
 * @returns {string}
 */

/**
 * @overload
 * @param {string} key
 * @param {number} plural
 * @returns {string}
 */

/**
 * @overload
 * @param {string} key
 * @param {unknown[]} list
 * @returns {string}
 */

/**
 * @overload
 * @param {string} key
 * @param {unknown[]} list
 * @param {number} plural
 * @returns {string}
 */

/**
 * @overload
 * @param {string} key
 * @param {Record<string, unknown>} named
 * @returns {string}
 */

/**
 * @overload
 * @param {string} key
 * @param {Record<string, unknown>} named
 * @param {number} plural
 * @returns {string}
 */

/**
 * @param {...any} args
 * @returns {string}
 */
function t(...args) {
  return i18n.global.t(...args)
}
