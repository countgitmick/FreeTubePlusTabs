import { useRouter } from 'vue-router'

import store from '../store/index'
import { readScrollPosition, SCROLL_CONTAINER_SELECTOR } from '../helpers/utils'

/**
 * Unified tab operations composable.
 *
 * Every tab state transition (close, switch, create, navigate) flows through
 * a single ceremony executor that implements the invariant protocol:
 *
 *   guard → saveScroll → plan → navigate(catch) → setActive → remove → persist → restoreScroll → clearGuard
 *
 * Callers become one-liners. The protocol is impossible to get wrong.
 */
export function useTabOperations() {
  const router = useRouter()

  // ── Ceremony executor ─────────────────────────────────────────────────

  /**
   * @typedef {object} CeremonyPlan
   * @property {{ path: string, query: object }|null} navigateRoute
   * @property {boolean} absorbNavigation - When true, the proxy increments
   *   tabSwitchNavCount so consumer route watchers ignore the navigation.
   *   When false, the route change propagates normally to view components.
   * @property {string|null} setActiveTabId
   * @property {string|null} removeTabId
   * @property {string[]|null} removeTabIds
   * @property {boolean} restoreScroll
   * @property {Array<{ mutation: string, payload: any }>} [preMutations]
   */

  /**
   * The single ceremony executor. Every tab operation flows through this.
   * Implements the proxy-load-balancer pattern: a single shock
   * absorber that serializes all tab state transitions.
   *
   * @param {(scrollPosition: { x: number, y: number }|null) => Promise<CeremonyPlan|null>|CeremonyPlan|null} planFn
   * @returns {Promise<void>}
   */
  async function executeCeremony(planFn) {
    if (store.getters['tabs/getTabSwitchInProgress']) return
    store.commit('tabs/setTabSwitchInProgress', true)

    try {
      const scrollPosition = readScrollPosition()
      const plan = await planFn(scrollPosition)
      if (!plan) return

      // Pre-mutations (e.g. updateTab for history navigation)
      if (plan.preMutations) {
        for (const { mutation, payload } of plan.preMutations) {
          store.commit(mutation, payload)
        }
      }

      // Navigate (fault-isolated: ceremony always completes).
      // absorbNavigation controls whether the proxy absorbs the route change
      // (tab switches) or lets it propagate to view watchers (history nav).
      if (plan.navigateRoute) {
        if (plan.absorbNavigation) {
          store.commit('tabs/incrementTabSwitchNavCount')
        }
        try {
          await router.replace({
            path: plan.navigateRoute.path,
            query: plan.navigateRoute.query
          })
        } catch (err) {
          console.error('Tab operation navigation failed:', err)
        } finally {
          if (plan.absorbNavigation) {
            store.commit('tabs/decrementTabSwitchNavCount')
          }
        }
      }

      // Set active tab (always after navigation settles)
      if (plan.setActiveTabId) {
        store.commit('tabs/setActiveTabId', plan.setActiveTabId)
      }

      // Deferred removal (always after setActiveTabId)
      if (plan.removeTabId) {
        store.commit('tabs/removeTab', plan.removeTabId)
      }
      if (plan.removeTabIds && plan.removeTabIds.length > 0) {
        store.commit('tabs/removeTabs', plan.removeTabIds)
      }

      // Persist
      store.dispatch('tabs/persistTabs')

      // Restore scroll position after navigation settles
      if (plan.restoreScroll && plan.setActiveTabId) {
        const tab = store.getters['tabs/getTabById'](plan.setActiveTabId)
        if (tab?.scrollPosition) {
          requestAnimationFrame(() => {
            const scrollEl = document.querySelector(SCROLL_CONTAINER_SELECTOR)
            if (scrollEl) {
              scrollEl.scrollTo(tab.scrollPosition.x, tab.scrollPosition.y)
            }
          })
        }
      }
    } finally {
      store.commit('tabs/setTabSwitchInProgress', false)
    }
  }

  // ── Close operations ──────────────────────────────────────────────────

  async function closeTab(tabId) {
    await executeCeremony(async () => {
      const result = await store.dispatch('tabs/closeTab', tabId)
      if (!result) return null // inactive tab — already removed by action

      return {
        navigateRoute: result.route,
        absorbNavigation: true,
        setActiveTabId: result.tabId,
        removeTabId: result.closeTabId,
        removeTabIds: null,
        restoreScroll: true,
      }
    })
  }

  async function closeOtherTabs(keepTabId) {
    await executeCeremony(async () => {
      const tabIdsToRemove = await store.dispatch('tabs/closeOtherTabs', keepTabId)
      const activeTabId = store.getters['tabs/getActiveTabId']
      const needsNavigation = activeTabId !== keepTabId
      const tab = store.getters['tabs/getTabById'](keepTabId)

      return {
        navigateRoute: needsNavigation && tab
          ? { path: tab.route.path, query: tab.route.query }
          : null,
        absorbNavigation: true,
        setActiveTabId: needsNavigation ? keepTabId : null,
        removeTabId: null,
        removeTabIds: tabIdsToRemove,
        restoreScroll: needsNavigation,
      }
    })
  }

  async function closeTabsToRight(tabId) {
    await executeCeremony(async () => {
      const tabs = store.getters['tabs/getTabs']
      const idx = tabs.findIndex(t => t.id === tabId)
      const activeIdx = tabs.findIndex(t => t.id === store.getters['tabs/getActiveTabId'])
      const activeWillBeRemoved = activeIdx > idx

      const tabIdsToRemove = await store.dispatch('tabs/closeTabsToRight', tabId)
      const tab = store.getters['tabs/getTabById'](tabId)

      return {
        navigateRoute: activeWillBeRemoved && tab
          ? { path: tab.route.path, query: tab.route.query }
          : null,
        absorbNavigation: true,
        setActiveTabId: activeWillBeRemoved ? tabId : null,
        removeTabId: null,
        removeTabIds: tabIdsToRemove,
        restoreScroll: activeWillBeRemoved,
      }
    })
  }

  // ── Switch operations ─────────────────────────────────────────────────

  async function switchToTab(tabId) {
    if (tabId === store.getters['tabs/getActiveTabId']) return

    await executeCeremony(async (scrollPosition) => {
      const targetRoute = await store.dispatch('tabs/switchTab', { tabId, scrollPosition })
      if (!targetRoute) return null

      return {
        navigateRoute: targetRoute,
        absorbNavigation: true,
        setActiveTabId: tabId,
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: true,
      }
    })
  }

  async function switchToNextTab() {
    const tabs = store.getters['tabs/getTabs']
    const activeId = store.getters['tabs/getActiveTabId']
    const currentIdx = tabs.findIndex(t => t.id === activeId)
    const nextIdx = (currentIdx + 1) % tabs.length
    const nextTab = tabs[nextIdx]
    if (nextTab && nextTab.id !== activeId) {
      await switchToTab(nextTab.id)
    }
  }

  async function switchToPrevTab() {
    const tabs = store.getters['tabs/getTabs']
    const activeId = store.getters['tabs/getActiveTabId']
    const currentIdx = tabs.findIndex(t => t.id === activeId)
    const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length
    const prevTab = tabs[prevIdx]
    if (prevTab && prevTab.id !== activeId) {
      await switchToTab(prevTab.id)
    }
  }

  async function switchToTabIndex(index) {
    const tabs = store.getters['tabs/getTabs']
    const targetTab = tabs[index]
    if (targetTab) {
      await switchToTab(targetTab.id)
    }
  }

  // ── Create operations ─────────────────────────────────────────────────

  async function createNewTab() {
    const landingPage = '/' + store.getters.getLandingPage

    await executeCeremony(async () => {
      const route = { path: landingPage, query: {} }
      const newTab = await store.dispatch('tabs/createTab', { route, makeActive: true })
      if (!newTab) return null // max tabs reached — don't navigate

      return {
        navigateRoute: route,
        absorbNavigation: true,
        setActiveTabId: null, // createTab already set makeActive
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: false,
      }
    })
  }

  async function reopenClosedTab() {
    await executeCeremony(async () => {
      const tab = await store.dispatch('tabs/reopenClosedTab')
      if (!tab) return null

      return {
        navigateRoute: { path: tab.route.path, query: tab.route.query },
        absorbNavigation: true,
        setActiveTabId: null, // reopenClosedTab → createTab handles this
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: false,
      }
    })
  }

  async function duplicateTab(tabId) {
    await executeCeremony(async () => {
      const newTab = await store.dispatch('tabs/duplicateTab', tabId)
      if (!newTab) return null

      return {
        navigateRoute: { path: newTab.route.path, query: newTab.route.query },
        absorbNavigation: true,
        setActiveTabId: null, // duplicateTab → createTab handles this
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: false,
      }
    })
  }

  // ── History operations ────────────────────────────────────────────────

  async function goBackInTab() {
    await executeCeremony(async () => {
      const activeTabId = store.getters['tabs/getActiveTabId']
      if (!activeTabId) return null

      const result = await store.dispatch('tabs/goBackInTab', activeTabId)
      if (!result) return null

      return {
        navigateRoute: result.route,
        absorbNavigation: false,
        setActiveTabId: null, // same tab, just different history entry
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: false,
        preMutations: [{
          mutation: 'tabs/updateTab',
          payload: {
            tabId: activeTabId,
            updates: { historyIndex: result.newIndex, route: result.route }
          }
        }],
      }
    })
  }

  async function goForwardInTab() {
    await executeCeremony(async () => {
      const activeTabId = store.getters['tabs/getActiveTabId']
      if (!activeTabId) return null

      const result = await store.dispatch('tabs/goForwardInTab', activeTabId)
      if (!result) return null

      return {
        navigateRoute: result.route,
        absorbNavigation: false,
        setActiveTabId: null,
        removeTabId: null,
        removeTabIds: null,
        restoreScroll: false,
        preMutations: [{
          mutation: 'tabs/updateTab',
          payload: {
            tabId: activeTabId,
            updates: { historyIndex: result.newIndex, route: result.route }
          }
        }],
      }
    })
  }

  return {
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    switchToTab,
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    createNewTab,
    reopenClosedTab,
    duplicateTab,
    goBackInTab,
    goForwardInTab,
  }
}
