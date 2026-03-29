import { DBTabsHandlers } from '../../../datastores/handlers/index.js'

const MAX_TAB_HISTORY = 100

/**
 * Shallow-compare two flat objects (e.g. route query params).
 * Faster than JSON.stringify for the common case of small query objects.
 */
function shallowEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every(key => a[key] === b[key])
}

/**
 * Clone a route object by reading through Vue Proxy wrappers.
 * Avoids JSON.parse(JSON.stringify()) overhead on hot paths.
 */
function cloneRoute(route) {
  return {
    path: route.path || '/',
    query: route.query ? { ...route.query } : {}
  }
}

/**
 * Create a plain-object snapshot of a tab for DB persistence or closed-tab history.
 * Shallow-copies the tab and uses cloneRoute() for route / history entries,
 * avoiding a full JSON round-trip.
 */
function cloneTabForPersistence(tab) {
  return {
    ...tab,
    route: cloneRoute(tab.route),
    history: tab.history.map(cloneRoute),
    scrollPosition: { ...tab.scrollPosition },
  }
}

let persistDebounceTimer = null
let persistRetried = false

const state = {
  tabs: [],
  activeTabId: null,
  closedTabsHistory: [],
  tabSwitchInProgress: false,
  tabSwitchNavCount: 0,
}

const getters = {
  getTabs(state) {
    return state.tabs
  },

  getActiveTabId(state) {
    return state.activeTabId
  },

  getActiveTab(state) {
    return state.tabs.find(tab => tab.id === state.activeTabId) || null
  },

  getTabById: (state) => (id) => {
    return state.tabs.find(tab => tab.id === id) || null
  },

  getTabCount(state) {
    return state.tabs.length
  },

  getClosedTabsHistory(state) {
    return state.closedTabsHistory
  },

  getTabsEnabled(_state, _getters, rootState) {
    return rootState.settings.enableTabs
  },

  getTabSwitchInProgress(state) {
    return state.tabSwitchInProgress
  },

  getTabSwitchNavCount(state) {
    return state.tabSwitchNavCount
  },
}

const mutations = {
  setTabs(state, tabs) {
    state.tabs = tabs
  },

  setActiveTabId(state, tabId) {
    state.activeTabId = tabId
  },

  addTab(state, { tab, index }) {
    if (index != null) {
      state.tabs.splice(index, 0, tab)
    } else {
      state.tabs.push(tab)
    }
  },

  removeTab(state, tabId) {
    state.tabs = state.tabs.filter(tab => tab.id !== tabId)
  },

  removeTabs(state, tabIds) {
    const idSet = new Set(tabIds)
    state.tabs = state.tabs.filter(tab => !idSet.has(tab.id))
  },

  updateTab(state, { tabId, updates }) {
    const tab = state.tabs.find(tab => tab.id === tabId)
    if (tab) {
      Object.assign(tab, updates)
    }
  },

  reorderTabs(state, tabs) {
    state.tabs = tabs
  },

  pushClosedTab(state, tab) {
    state.closedTabsHistory.push(tab)
    // Keep max 20 closed tabs
    if (state.closedTabsHistory.length > 20) {
      state.closedTabsHistory.shift()
    }
  },

  popClosedTab(state) {
    return state.closedTabsHistory.pop()
  },

  setTabPlayerState(state, { tabId, playerState }) {
    const tab = state.tabs.find(tab => tab.id === tabId)
    if (tab) {
      tab.playerState = playerState
    }
  },

  setTabMediaPlaying(state, { tabId, mediaPlaying }) {
    const tab = state.tabs.find(tab => tab.id === tabId)
    if (tab) {
      tab.mediaPlaying = mediaPlaying
    }
  },

  refreshTab(state, tabId) {
    const tab = state.tabs.find(tab => tab.id === tabId)
    if (tab) {
      tab.refreshKey = (tab.refreshKey || 0) + 1
    }
  },

  setTabSwitchInProgress(state, val) {
    state.tabSwitchInProgress = val
  },

  setTabSwitchNavCount(state, val) {
    state.tabSwitchNavCount = val
  },

  incrementTabSwitchNavCount(state) {
    state.tabSwitchNavCount++
  },

  decrementTabSwitchNavCount(state) {
    state.tabSwitchNavCount = Math.max(0, state.tabSwitchNavCount - 1)
  },
}

function createTabObject(route, title = '', icon = 'home') {
  const id = 'tab-' + crypto.randomUUID()
  const routeClone = cloneRoute(route)
  return {
    id,
    route: routeClone,
    title: title || routeNameFromPath(routeClone.path),
    icon,
    history: [routeClone],
    historyIndex: 0,
    scrollPosition: { x: 0, y: 0 },
    playerState: null,
    mediaPlaying: false,
    refreshKey: 0,
  }
}

function routeNameFromPath(path) {
  const routeTitles = {
    '/subscriptions': 'Subscriptions',
    '/subscribedchannels': 'Channels',
    '/trending': 'Trending',
    '/popular': 'Most Popular',
    '/userplaylists': 'Your Playlists',
    '/history': 'History',
    '/settings': 'Settings',
    '/about': 'About',
  }

  for (const [prefix, title] of Object.entries(routeTitles)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return title
    }
  }

  if (path.startsWith('/watch/')) return 'Watch'
  if (path.startsWith('/channel/')) return 'Channel'
  if (path.startsWith('/search/')) return 'Search Results'
  if (path.startsWith('/playlist/')) return 'Playlist'
  if (path.startsWith('/hashtag/')) return 'Hashtag'
  if (path.startsWith('/post/')) return 'Post'

  return 'New Tab'
}

function iconFromPath(path) {
  if (path.startsWith('/watch/')) return 'play'
  if (path.startsWith('/channel/')) return 'user'
  if (path.startsWith('/search/')) return 'search'
  if (path.startsWith('/subscriptions')) return 'rss'
  if (path.startsWith('/trending')) return 'fire'
  if (path.startsWith('/popular')) return 'fire'
  if (path.startsWith('/history')) return 'history'
  if (path.startsWith('/settings')) return 'cog'
  if (path.startsWith('/playlist/')) return 'list'
  if (path.startsWith('/userplaylists')) return 'list'
  if (path.startsWith('/hashtag/')) return 'hashtag'
  return 'home'
}

const actions = {
  persistTabs({ state, dispatch }) {
    if (typeof DBTabsHandlers === 'undefined') return

    clearTimeout(persistDebounceTimer)
    persistDebounceTimer = setTimeout(() => {
      const data = {
        tabs: state.tabs.map(cloneTabForPersistence),
        activeTabId: state.activeTabId,
      }
      DBTabsHandlers.upsert(data).then(() => {
        persistRetried = false
      }).catch((e) => {
        console.error('Failed to persist tabs:', e)
        if (!persistRetried) {
          persistRetried = true
          dispatch('persistTabs')
        }
      })
    }, 500)
  },

  /** Immediately persist tabs (for beforeunload). */
  persistTabsImmediate({ state }) {
    if (typeof DBTabsHandlers === 'undefined') return
    clearTimeout(persistDebounceTimer)
    const data = {
      tabs: state.tabs.map(cloneTabForPersistence),
      activeTabId: state.activeTabId,
    }
    DBTabsHandlers.upsert(data).catch((e) => {
      console.error('Failed to persist tabs:', e)
    })
  },

  async restoreTabs({ commit, dispatch }) {
    try {
      const results = await DBTabsHandlers.find()
      if (results.length > 0 && results[0].tabs && results[0].tabs.length > 0) {
        const session = results[0]
        // Validate and filter malformed tabs, clear transient player state
        const tabs = session.tabs
          .filter(tab => tab && typeof tab.id === 'string' &&
            tab.route && typeof tab.route.path === 'string' &&
            Array.isArray(tab.history))
          .map(tab => ({ ...tab, playerState: null, mediaPlaying: false }))
        if (tabs.length === 0) return false
        commit('setTabs', tabs)
        commit('setActiveTabId', session.activeTabId)
        return true
      }
    } catch (e) {
      console.error('Failed to restore tabs:', e)
    }
    return false
  },

  createTab({ commit, state, rootState, dispatch }, { route, makeActive = true }) {
    const maxTabs = rootState.settings.maxTabs || 20
    if (state.tabs.length >= maxTabs) {
      return null
    }

    const icon = iconFromPath(route.path || '/')
    const tab = createTabObject(route, '', icon)
    const activeIdx = state.tabs.findIndex(t => t.id === state.activeTabId)
    commit('addTab', { tab, index: activeIdx !== -1 ? activeIdx + 1 : undefined })

    if (makeActive) {
      commit('setActiveTabId', tab.id)
    }

    dispatch('persistTabs')
    return tab
  },

  closeTab({ commit, state, dispatch, rootState }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return null

    const wasActive = state.activeTabId === tabId

    // Save to closed history
    commit('pushClosedTab', cloneTabForPersistence(tab))

    let nextTabId = null
    let nextRoute = null

    // If closing the last tab, create a default one first
    if (state.tabs.length === 1) {
      const landingPage = rootState.settings.landingPage || 'subscriptions'
      const route = { path: '/' + landingPage, query: {} }
      const icon = iconFromPath(route.path)
      const newTab = createTabObject(route, '', icon)
      commit('addTab', { tab: newTab })
      nextTabId = newTab.id
      nextRoute = cloneRoute(newTab.route)
    } else if (wasActive) {
      // Determine adjacent tab but don't activate yet
      const idx = state.tabs.findIndex(t => t.id === tabId)
      const adjacentTab = state.tabs[idx + 1] || state.tabs[idx - 1]
      if (adjacentTab) {
        nextTabId = adjacentTab.id
        nextRoute = cloneRoute(adjacentTab.route)
      }
    }

    // Deferred removal: when closing the active tab, the caller must navigate
    // and set activeTabId BEFORE removing the tab from the array. This prevents
    // Vue from unmounting the component while route/state effects are in flight
    // (decouple visual mapping from state transitions).
    if (wasActive && nextTabId) {
      return { tabId: nextTabId, route: nextRoute, closeTabId: tabId }
    }

    // Inactive tab: safe to remove immediately — no navigation in flight
    commit('removeTab', tabId)
    dispatch('persistTabs')
    return null
  },

  switchTab({ commit, state }, { tabId, scrollPosition }) {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    if (currentTab && scrollPosition) {
      // Save scroll position of current tab (provided by the caller)
      commit('updateTab', {
        tabId: currentTab.id,
        updates: {
          scrollPosition: {
            x: scrollPosition.x || 0,
            y: scrollPosition.y || 0,
          }
        }
      })
    }

    // Don't set activeTabId here — caller must navigate the router first,
    // then commit setActiveTabId so the component remounts with the correct route.
    const targetTab = state.tabs.find(t => t.id === tabId)
    return targetTab ? cloneRoute(targetTab.route) : null
  },

  navigateInTab({ commit, state, dispatch }, { tabId, route }) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    // Guard against incomplete routes (e.g. "/channel/" with no ID)
    const path = route.path || '/'
    if (/^\/(channel|watch|search|playlist|hashtag|post)\/?$/.test(path)) return

    const routeClone = cloneRoute({ path, query: route.query })

    // Check if this is the same route
    const currentRoute = tab.history[tab.historyIndex]
    if (currentRoute && currentRoute.path === routeClone.path &&
        shallowEqual(currentRoute.query, routeClone.query)) {
      return
    }

    // Truncate forward history and push new route
    let newHistory = tab.history.slice(0, tab.historyIndex + 1)
    newHistory.push(routeClone)

    // Cap history length to prevent unbounded growth
    let newIndex = newHistory.length - 1
    if (newHistory.length > MAX_TAB_HISTORY) {
      const excess = newHistory.length - MAX_TAB_HISTORY
      newHistory = newHistory.slice(excess)
      newIndex -= excess
    }

    const icon = iconFromPath(routeClone.path)
    const title = routeNameFromPath(routeClone.path)

    commit('updateTab', {
      tabId,
      updates: {
        route: routeClone,
        history: newHistory,
        historyIndex: newIndex,
        title,
        icon,
      }
    })
    dispatch('persistTabs')
  },

  goBackInTab({ state }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab || tab.historyIndex <= 0) return null

    const newIndex = tab.historyIndex - 1
    const route = cloneRoute(tab.history[newIndex])
    return { route, newIndex }
  },

  goForwardInTab({ state }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab || tab.historyIndex >= tab.history.length - 1) return null

    const newIndex = tab.historyIndex + 1
    const route = cloneRoute(tab.history[newIndex])
    return { route, newIndex }
  },

  reopenClosedTab({ state, dispatch, commit }) {
    if (state.closedTabsHistory.length === 0) return

    const closedTab = state.closedTabsHistory[state.closedTabsHistory.length - 1]
    commit('popClosedTab')

    return dispatch('createTab', {
      route: closedTab.route,
      makeActive: true,
    })
  },

  closeOtherTabs({ state, commit }, tabId) {
    const tabsToClose = state.tabs.filter(t => t.id !== tabId)
    for (const tab of tabsToClose) {
      commit('pushClosedTab', cloneTabForPersistence(tab))
    }

    // Deferred removal: return IDs so caller can navigate/set activeTabId first,
    // then remove the tabs after the state transition is settled.
    return tabsToClose.map(t => t.id)
  },

  closeTabsToRight({ state, commit }, tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return []

    const tabsToClose = state.tabs.slice(idx + 1)
    for (const tab of tabsToClose) {
      commit('pushClosedTab', cloneTabForPersistence(tab))
    }

    // Deferred removal: return IDs so caller removes after state transition
    return tabsToClose.map(t => t.id)
  },

  duplicateTab({ state, dispatch }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    return dispatch('createTab', {
      route: cloneRoute(tab.route),
      makeActive: true,
    })
  },
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions,
}
