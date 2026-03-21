import { DBTabsHandlers } from '../../../datastores/handlers/index.js'

const state = {
  tabs: [],
  activeTabId: null,
  closedTabsHistory: [],
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
}

const mutations = {
  setTabs(state, tabs) {
    state.tabs = tabs
  },

  setActiveTabId(state, tabId) {
    state.activeTabId = tabId
  },

  addTab(state, tab) {
    state.tabs.push(tab)
  },

  removeTab(state, tabId) {
    state.tabs = state.tabs.filter(tab => tab.id !== tabId)
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
}

function createTabObject(route, title = '', icon = 'home') {
  const id = 'tab-' + crypto.randomUUID()
  const routeClone = JSON.parse(JSON.stringify({
    path: route.path || '/',
    query: route.query || {}
  }))
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
  persistTabs({ state }) {
    if (typeof DBTabsHandlers === 'undefined') return
    const data = {
      tabs: JSON.parse(JSON.stringify(state.tabs)),
      activeTabId: state.activeTabId,
    }
    try {
      DBTabsHandlers.upsert(data)
    } catch (e) {
      console.error('Failed to persist tabs:', e)
    }
  },

  async restoreTabs({ commit, dispatch }) {
    try {
      const results = await DBTabsHandlers.find()
      if (results.length > 0 && results[0].tabs && results[0].tabs.length > 0) {
        const session = results[0]
        // Clear playerState on restore (don't persist player state across restarts)
        const tabs = session.tabs.map(tab => ({ ...tab, playerState: null, mediaPlaying: false }))
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
    commit('addTab', tab)

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
    commit('pushClosedTab', JSON.parse(JSON.stringify(tab)))

    let nextTabId = null
    let nextRoute = null

    // If closing the last tab, create a default one first
    if (state.tabs.length === 1) {
      const landingPage = rootState.settings.landingPage || 'subscriptions'
      const route = { path: '/' + landingPage, query: {} }
      const icon = iconFromPath(route.path)
      const newTab = createTabObject(route, '', icon)
      commit('addTab', newTab)
      nextTabId = newTab.id
      nextRoute = JSON.parse(JSON.stringify(newTab.route))
    } else if (wasActive) {
      // Determine adjacent tab but don't activate yet
      const idx = state.tabs.findIndex(t => t.id === tabId)
      const adjacentTab = state.tabs[idx + 1] || state.tabs[idx - 1]
      if (adjacentTab) {
        nextTabId = adjacentTab.id
        nextRoute = JSON.parse(JSON.stringify(adjacentTab.route))
      }
    }

    commit('removeTab', tabId)
    dispatch('persistTabs')

    // Return next tab info so caller can navigate then commit setActiveTabId
    if (wasActive && nextTabId) {
      return { tabId: nextTabId, route: nextRoute }
    }
    return null
  },

  switchTab({ commit, state }, tabId) {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    if (currentTab && typeof window !== 'undefined') {
      // Save scroll position of current tab — select the visible container
      const scrollEl = document.querySelector('.routerView[style*="display: block"]') ||
        document.querySelector('.flexBox.routerView')
      if (scrollEl) {
        commit('updateTab', {
          tabId: currentTab.id,
          updates: {
            scrollPosition: {
              x: scrollEl.scrollLeft || 0,
              y: scrollEl.scrollTop || 0,
            }
          }
        })
      }
    }

    // Don't set activeTabId here — caller must navigate the router first,
    // then commit setActiveTabId so the component remounts with the correct route.
    const targetTab = state.tabs.find(t => t.id === tabId)
    return targetTab ? JSON.parse(JSON.stringify(targetTab.route)) : null
  },

  navigateInTab({ commit, state, dispatch }, { tabId, route }) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    // Guard against incomplete routes (e.g. "/channel/" with no ID)
    const path = route.path || '/'
    if (/^\/(channel|watch|search|playlist|hashtag|post)\/?$/.test(path)) return

    const routeClone = JSON.parse(JSON.stringify({
      path,
      query: route.query || {}
    }))

    // Check if this is the same route
    const currentRoute = tab.history[tab.historyIndex]
    if (currentRoute && currentRoute.path === routeClone.path &&
        JSON.stringify(currentRoute.query) === JSON.stringify(routeClone.query)) {
      return
    }

    // Truncate forward history and push new route
    const newHistory = tab.history.slice(0, tab.historyIndex + 1)
    newHistory.push(routeClone)

    const icon = iconFromPath(routeClone.path)
    const title = routeNameFromPath(routeClone.path)

    commit('updateTab', {
      tabId,
      updates: {
        route: routeClone,
        history: newHistory,
        historyIndex: newHistory.length - 1,
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
    const route = JSON.parse(JSON.stringify(tab.history[newIndex]))
    return { route, newIndex }
  },

  goForwardInTab({ state }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab || tab.historyIndex >= tab.history.length - 1) return null

    const newIndex = tab.historyIndex + 1
    const route = JSON.parse(JSON.stringify(tab.history[newIndex]))
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
      commit('pushClosedTab', JSON.parse(JSON.stringify(tab)))
    }

    const keepTab = state.tabs.find(t => t.id === tabId)
    commit('setTabs', keepTab ? [keepTab] : [])
    if (keepTab) {
      commit('setActiveTabId', keepTab.id)
    }
  },

  closeTabsToRight({ state, commit }, tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return

    const tabsToClose = state.tabs.slice(idx + 1)
    for (const tab of tabsToClose) {
      commit('pushClosedTab', JSON.parse(JSON.stringify(tab)))
    }

    commit('setTabs', state.tabs.slice(0, idx + 1))
  },

  duplicateTab({ state, dispatch }, tabId) {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    return dispatch('createTab', {
      route: JSON.parse(JSON.stringify(tab.route)),
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
