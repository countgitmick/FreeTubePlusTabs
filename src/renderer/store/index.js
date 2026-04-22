import { createStore } from 'vuex'
// import createPersistedState from 'vuex-persistedstate'

import history from './modules/history'
import invidious from './modules/invidious'
import playlists from './modules/playlists'
import profiles from './modules/profiles'
import settings from './modules/settings'
import searchHistory from './modules/search-history'
import subscriptionCache from './modules/subscription-cache'
import subscriptionRefreshCoordinator, { _bindStore as bindCoordinatorStore } from './modules/subscription-refresh-coordinator'
import tabs from './modules/tabs'
import utils from './modules/utils'
import player from './modules/player'

const store = createStore({
  modules: {
    history,
    invidious,
    playlists,
    profiles,
    settings,
    searchHistory,
    subscriptionCache,
    subscriptionRefreshCoordinator,
    tabs,
    utils,
    player,
  },

  // Detects unsafe changes to the store state e.g. outside of mutations
  // but we have to turn it off despite its usefulness as we have so much data in the store
  // that it causes a noticable slow-down :(
  strict: false

  // TODO: Enable when deploy
  // plugins: [createPersistedState()]
})

// The coordinator module holds a module-local ref to the store so its worker
// loop can read getters and dispatch cache updates without threading the
// store through every function.
bindCoordinatorStore(store)

export default store
