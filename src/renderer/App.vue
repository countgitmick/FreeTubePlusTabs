<template>
  <div
    v-if="dataReady"
    class="app"
    :class="{
      hideOutlines: outlinesHidden,
      isLocaleRightToLeft: isLocaleRightToLeft,
      isSideNavOpen: isSideNavOpen,
      hideLabelsSideBar: hideLabelsSideBar && !isSideNavOpen
    }"
  >
    <TopNav
      :inert="isAnyPromptOpen"
    />
    <SideNav
      :inert="isAnyPromptOpen"
    />
    <FtFlexBox
      class="flexBox routerView"
      :class="{ tabsEnabled: enableTabs }"
      role="main"
      :inert="isAnyPromptOpen"
    >
      <FtTabBar
        v-if="enableTabs"
        :inert="isAnyPromptOpen"
      />
      <div
        v-if="showBlogBanner"
        class="banner-wrapper"
      >
        <FtNotificationBanner
          class="banner"
          :message="blogBannerMessage"
          role="link"
          @click="handleNewBlogBannerClick"
        />
      </div>
      <!-- Multi-container tabs: all tabs rendered simultaneously, toggled with v-show.
           Uses stableTabList (sorted by ID) so drag-reorder never moves heavy DOM nodes. -->
      <template v-if="enableTabs">
        <div
          v-for="tab in stableTabList"
          v-show="tab.id === activeTabId"
          :key="tab.id"
          class="routerView"
          :data-tab-active="tab.id === activeTabId ? '' : undefined"
        >
          <TabContent :tab="tab" />
        </div>
      </template>
      <!-- Non-tab mode: normal router view with transitions -->
      <RouterView
        v-else
        v-slot="{ Component }"
        class="routerView"
      >
        <Transition
          mode="out-in"
          name="fade"
        >
          <component :is="Component" />
        </Transition>
      </RouterView>
    </FtFlexBox>
    <FtPrompt
      v-if="showExternalLinkOpeningPrompt"
      :label="t('Are you sure you want to open this link?')"
      :extra-labels="[lastExternalLinkToBeOpened]"
      :option-names="externalLinkOpeningPromptNames"
      :option-values="EXTERNAL_LINK_OPENING_PROMPT_VALUES"
      @click="handleExternalLinkOpeningPromptAnswer"
    />
    <FtSearchFilters
      v-if="showSearchFilters"
    />
    <FtKeyboardShortcutPrompt
      v-if="isKeyboardShortcutPromptShown"
    />
    <FtPlaylistAddVideoPrompt
      v-if="showAddToPlaylistPrompt"
    />
    <FtCreatePlaylistPrompt
      v-if="showCreatePlaylistPrompt"
    />
    <FtToast />
    <FtProgressBar
      v-if="showProgressBar"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from './composables/use-i18n-polyfill'
import { useTabOperations } from './composables/use-tab-operations'
import { useRoute, useRouter } from 'vue-router'

import FtFlexBox from './components/ft-flex-box/ft-flex-box.vue'
import TopNav from './components/TopNav/TopNav.vue'
import SideNav from './components/SideNav/SideNav.vue'
import FtNotificationBanner from './components/FtNotificationBanner/FtNotificationBanner.vue'
import FtPrompt from './components/FtPrompt/FtPrompt.vue'
import FtToast from './components/FtToast/FtToast.vue'
import FtProgressBar from './components/FtProgressBar/FtProgressBar.vue'
import FtPlaylistAddVideoPrompt from './components/FtPlaylistAddVideoPrompt/FtPlaylistAddVideoPrompt.vue'
import FtCreatePlaylistPrompt from './components/FtCreatePlaylistPrompt/FtCreatePlaylistPrompt.vue'
import FtKeyboardShortcutPrompt from './components/FtKeyboardShortcutPrompt/FtKeyboardShortcutPrompt.vue'
import FtSearchFilters from './components/FtSearchFilters/FtSearchFilters.vue'
import FtTabBar from './components/FtTabBar/FtTabBar.vue'
import TabContent from './components/TabContent/TabContent.vue'

import store from './store/index'

import packageDetails from '../../package.json'
import { openExternalLink, openInternalPath, showToast } from './helpers/utils'
import { translateWindowTitle } from './helpers/strings'
import { loadLocale } from './i18n/index'

const route = useRoute()
const router = useRouter()
const { locale, t } = useI18n()
const { closeTab, switchToNextTab, switchToPrevTab, switchToTabIndex, createNewTab, reopenClosedTab } = useTabOperations()

/** @type {import('vue').ComputedRef<boolean>} */
const isSideNavOpen = computed(() => store.getters.getIsSideNavOpen)

/** @type {import('vue').ComputedRef<boolean>} */
const hideLabelsSideBar = computed(() => store.getters.getHideLabelsSideBar)

/** @type {import('vue').ComputedRef<boolean>} */
const isAnyPromptOpen = computed(() => store.getters.isAnyPromptOpen)

/** @type {import('vue').ComputedRef<boolean>} */
const showSearchFilters = computed(() => store.getters.getShowSearchFilters)

/** @type {import('vue').ComputedRef<boolean>} */
const isKeyboardShortcutPromptShown = computed(() => store.getters.getIsKeyboardShortcutPromptShown)

/** @type {import('vue').ComputedRef<boolean>} */
const showAddToPlaylistPrompt = computed(() => store.getters.getShowAddToPlaylistPrompt)

/** @type {import('vue').ComputedRef<boolean>} */
const showCreatePlaylistPrompt = computed(() => store.getters.getShowCreatePlaylistPrompt)

/** @type {import('vue').ComputedRef<boolean>} */
const showProgressBar = computed(() => store.getters.getShowProgressBar)

const landingPage = computed(() => '/' + store.getters.getLandingPage)

const enableTabs = computed(() => store.getters.getEnableTabs)
const activeTabId = computed(() => store.getters['tabs/getActiveTabId'])
const tabs = computed(() => store.getters['tabs/getTabs'])

// Stable content list — same tabs but never reorders on drag.
// Tab content containers are persistent background renderers (like offscreen backbuffers);
// their DOM order is irrelevant, only v-show visibility metadata matters.
const stableTabList = computed(() => {
  return [...tabs.value].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
})
/** @type {import('vue').ComputedRef<string>} */
const defaultInvidiousInstance = computed(() => store.getters.getDefaultInvidiousInstance)

const dataReady = ref(false)

onMounted(async () => {
  // Capture the true startup route synchronously, before any await and before
  // the landing-page redirect below rewrites route.path. A deep-link window
  // (Shift+click "open in new window") boots with a non-root hash; the main
  // window boots at '/'. Reading route.path later (in the fire-and-forget
  // grabAllProfiles callback) races the `router.replace(landingPage)` redirect
  // and misclassifies every normal restart as a deep-link, which disabled tab
  // restore + persist and flushed the saved session. (#116 regression)
  const startupPath = route.path

  await store.dispatch('grabUserSettings')

  updateTheme()

  await store.dispatch('fetchInvidiousInstancesFromFile')
  if (defaultInvidiousInstance.value === '') {
    await store.dispatch('setRandomCurrentInvidiousInstance')
  }

  store.dispatch('fetchInvidiousInstances').then(() => {
    if (defaultInvidiousInstance.value === '') {
      store.dispatch('setRandomCurrentInvidiousInstance')
    }
  })

  store.dispatch('grabAllProfiles', t('Profile.All Channels')).then(async () => {
    Promise.allSettled([
      store.dispatch('grabHistory'),
      store.dispatch('grabAllPlaylists'),
      store.dispatch('grabAllSubscriptions'),
      store.dispatch('grabSearchHistoryEntries'),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('Failed to load data on startup:', result.reason)
        }
      }
      // Start the background subscription refresh coordinator once profiles
      // and the subscription cache are loaded. It paces itself; safe to fire
      // and forget. Unconditionally started; the loop no-ops on empty profiles.
      store.dispatch('startCoordinator')
    })

    if (process.env.IS_ELECTRON) {
      store.dispatch('setupListenersToSyncWindows')
      document.addEventListener('click', handleClick)
      document.addEventListener('auxclick', handleAuxClick)
      enableOpenUrl()
      enableOpenInNewTab()
      store.dispatch('getExternalPlayerCmdArgumentsData')
    }

    // Initialize tabs before dataReady so the UI renders with tabs ready
    if (enableTabs.value) {
      // A window opened with an explicit deep-link (e.g. Shift+click "open in
      // new window") arrives with a non-root startup route. It should show just
      // that page as a fresh tab rather than cloning the previous session, and
      // must not persist over the saved session. (#116)
      const isDeepLinkStartup = startupPath !== '/'
      if (isDeepLinkStartup) {
        store.commit('tabs/setEphemeral', true)
      }

      const restored = !isDeepLinkStartup && await store.dispatch('tabs/restoreTabs')
      if (restored) {
        const activeTab = store.getters['tabs/getActiveTab']
        if (activeTab) {
          store.commit('tabs/incrementTabSwitchNavCount')
          try {
            await router.replace({ path: activeTab.route.path, query: activeTab.route.query })
          } finally {
            store.commit('tabs/decrementTabSwitchNavCount')
          }
        }
      } else if (store.getters['tabs/getTabCount'] === 0) {
        store.dispatch('tabs/createTab', {
          route: { path: route.path === '/' ? landingPage.value : route.path, query: route.query || {} },
          makeActive: true,
        })
      }

      window.addEventListener('beforeunload', () => {
        store.dispatch('tabs/persistTabsImmediate')
      })
    }

    // Sync route changes back to active tab
    router.afterEach((to) => {
      if (!enableTabs.value) return
      if (store.getters['tabs/getTabSwitchNavCount'] > 0) return

      const currentTabId = store.getters['tabs/getActiveTabId']
      if (currentTabId) {
        store.dispatch('tabs/navigateInTab', {
          tabId: currentTabId,
          route: { path: to.path, query: to.query || {} },
        })
      }
    })

    dataReady.value = true

    setTimeout(() => {
      checkForNewBlogPosts()
    }, 500)
  })

  if (route.path === '/') {
    router.replace({ path: landingPage.value })
  }

  setWindowTitle()

  document.addEventListener('keydown', handleKeyboardShortcuts)
  document.addEventListener('mousedown', handleMouseDown)
  document.addEventListener('dragstart', handleDragStart)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeyboardShortcuts)
  document.removeEventListener('mousedown', handleMouseDown)
  document.removeEventListener('dragstart', handleDragStart)
  document.removeEventListener('click', handleClick)
  document.removeEventListener('auxclick', handleAuxClick)
})

/** @type {import('vue').ComputedRef<string>} */
const baseTheme = computed(() => store.getters.getBaseTheme)

watch(baseTheme, updateTheme)

/** @type {import('vue').ComputedRef<string>} */
const mainColor = computed(() => store.getters.getMainColor)

watch(mainColor, updateTheme)

/** @type {import('vue').ComputedRef<string>} */
const secColor = computed(() => store.getters.getSecColor)

watch(secColor, updateTheme)

function updateTheme() {
  document.body.className = `${baseTheme.value || 'system'} main${mainColor.value || 'Red'} sec${secColor.value || 'Blue'}`
  document.body.dataset.systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

updateTheme()

const showBlogBanner = ref(false)
const latestBlogTitle = ref('')
const latestBlogUrl = ref('')

const blogBannerMessage = computed(() => {
  return t('A new blog is now available, {blogTitle}. Click to view more', { blogTitle: latestBlogTitle.value })
})

/** @type {import('vue').ComputedRef<boolean>} */
const checkForBlogPosts = computed(() => store.getters.getCheckForBlogPosts)

async function checkForNewBlogPosts() {
  if (!checkForBlogPosts.value) {
    return
  }

  try {
    let lastAppWasRunning = localStorage.getItem('lastAppWasRunning')

    if (lastAppWasRunning !== null) {
      lastAppWasRunning = new Date(lastAppWasRunning)
    }

    const response = await fetch('https://write.as/freetube/feed/')
    const text = await response.text()
    const xmlDom = new DOMParser().parseFromString(text, 'application/xml')

    const latestBlog = xmlDom.querySelector('item')
    if (!latestBlog) return

    const latestPubDate = new Date(latestBlog.querySelector('pubDate').textContent)

    if (lastAppWasRunning === null || latestPubDate > lastAppWasRunning) {
      latestBlogTitle.value = latestBlog.querySelector('title').textContent
      latestBlogUrl.value = latestBlog.querySelector('link').textContent
      showBlogBanner.value = true
    }

    localStorage.setItem('lastAppWasRunning', new Date())
  } catch (error) {
    console.error('Failed to check for new blog posts:', error)
  }
}

/**
 * @param {boolean} response
 */
function handleNewBlogBannerClick(response) {
  if (response) {
    openExternalLink(latestBlogUrl.value)
  }

  showBlogBanner.value = false
}

/** @type {import('vue').ComputedRef<boolean>} */
const outlinesHidden = computed(() => store.getters.getOutlinesHidden)

/**
 * @param {KeyboardEvent} event
 */
async function handleKeyboardShortcuts(event) {
  // ignore user typing in HTML `input` elements
  if (event.shiftKey && event.key === '?' && event.target.tagName !== 'INPUT') {
    store.commit('setIsKeyboardShortcutPromptShown', !isKeyboardShortcutPromptShown.value)
  }

  if (event.key === 'Tab' && !event.ctrlKey) {
    store.dispatch('showOutlines')
  }

  // Tab keyboard shortcuts (only when tabs are enabled)
  if (!enableTabs.value) return

  const ctrlOrCmd = (process.platform !== 'darwin' && event.ctrlKey) ||
    (process.platform === 'darwin' && event.metaKey)

  if (!ctrlOrCmd) return

  // Ctrl+T — New tab
  if (event.key === 't' || event.key === 'T') {
    if (!event.shiftKey) {
      event.preventDefault()
      await createNewTab()
    } else {
      // Ctrl+Shift+T — Reopen closed tab
      event.preventDefault()
      await reopenClosedTab()
    }
    return
  }

  // Ctrl+W — Close active tab
  if (event.key === 'w' || event.key === 'W') {
    event.preventDefault()
    const tabs = store.getters['tabs/getTabs']
    if (tabs.length === 1) {
      // Last tab — close window
      if (process.env.IS_ELECTRON) {
        window.close()
      }
      return
    }
    const activeId = store.getters['tabs/getActiveTabId']
    await closeTab(activeId)
    return
  }

  // Ctrl+Tab / Ctrl+Shift+Tab — Next/Previous tab
  if (event.key === 'Tab') {
    event.preventDefault()
    if (event.shiftKey) {
      await switchToPrevTab()
    } else {
      await switchToNextTab()
    }
    return
  }

  // Ctrl+1-9 — Jump to tab by index
  const num = parseInt(event.key)
  if (num >= 1 && num <= 9) {
    event.preventDefault()
    await switchToTabIndex(num === 9 ? store.getters['tabs/getTabs'].length - 1 : num - 1)
  }
}

function handleMouseDown() {
  store.dispatch('hideOutlines')
}

const lastExternalLinkToBeOpened = ref('')
const showExternalLinkOpeningPrompt = ref(false)
const EXTERNAL_LINK_OPENING_PROMPT_VALUES = ['yes', 'no']

const externalLinkOpeningPromptNames = computed(() => [
  t('Yes, Open Link'),
  t('No')
])

/** @type {import('vue').ComputedRef<'' | 'openLinkAfterPrompt' | 'doNothing'>} */
const externalLinkHandling = computed(() => store.getters.getExternalLinkHandling)

/**
 * @param {'yes' | 'no' | null} option
 */
function handleExternalLinkOpeningPromptAnswer(option) {
  showExternalLinkOpeningPrompt.value = false

  if (option === 'yes' && lastExternalLinkToBeOpened.value.length > 0) {
    // Maybe user should be notified
    // if `lastExternalLinkToBeOpened` is empty

    // Open links externally
    openExternalLink(lastExternalLinkToBeOpened.value)
  }
}

/**
 * @param {PointerEvent} event
 */
function isExternalLink(event) {
  return event.target.tagName === 'A' && !event.target.href.startsWith(window.location.origin)
}

/**
 * Resolves the FreeTube route from an internal link the event originated on
 * (the target may be a child element of the `<a>`). Returns null for external
 * links or non-link targets.
 * @param {EventTarget} target
 * @returns {{ path: string, query: object } | null}
 */
function parseInternalLinkRoute(target) {
  const link = target.closest?.('a[href]')
  if (!link) return null

  const href = link.href
  if (!href || !href.startsWith(window.location.origin)) return null

  return parseAppLinkUrl(href)
}

/**
 * Parse an in-app link URL (e.g. from the Electron context menu) into a route.
 * @param {string} linkURL
 * @returns {{ path: string, query: object } | null}
 */
function parseAppLinkUrl(linkURL) {
  if (!linkURL || typeof linkURL !== 'string') return null

  // Reject anything outside the app's own origin here rather than at the call
  // sites. parseInternalLinkRoute checked it, but the context-menu path calls
  // this directly — so keeping the check inside means it holds for every
  // caller, including any added later.
  if (!linkURL.startsWith(window.location.origin)) return null

  try {
    const url = new URL(linkURL)
    // Extract the route path from the hash (format: #/path?query)
    const hashPath = url.hash.slice(1) // remove #
    if (!hashPath) return null
    const [path, queryString] = hashPath.split('?')
    if (!path) return null
    const query = queryString ? Object.fromEntries(new URLSearchParams(queryString)) : {}
    return { path, query }
  } catch {
    return null
  }
}

/**
 * @param {PointerEvent} event
 */
function handleClick(event) {
  if (isExternalLink(event)) {
    handleLinkClick(event)
    return
  }

  // Tab-aware modifier clicks on internal links. Vue Router's <router-link>
  // ignores modified clicks, so without this they fall through to the main
  // process window-open handler and spawn a new window instead of a new tab.
  // (#112, #113, #116)
  if (!enableTabs.value) return

  const ctrlOrCmd = (process.platform !== 'darwin' && event.ctrlKey) ||
    (process.platform === 'darwin' && event.metaKey)
  if (!ctrlOrCmd && !event.shiftKey) return

  const route = parseInternalLinkRoute(event.target)
  if (!route) return

  event.preventDefault()
  if (ctrlOrCmd) {
    // Ctrl/Cmd+click -> new background tab
    openInternalPath({ ...route, doCreateNewTab: true })
  } else {
    // Shift+click -> new window containing just this page
    openInternalPath({ ...route, doCreateNewWindow: true })
  }
}

/**
 * @param {PointerEvent} event
 */
function handleAuxClick(event) {
  // auxclick fires for all clicks not performed with the primary button
  // only handle the link click if it was the middle button,
  // otherwise the context menu breaks
  if (event.button !== 1) return

  if (isExternalLink(event)) {
    handleLinkClick(event)
    return
  }

  // Middle-click on internal link opens in a new background tab
  if (!enableTabs.value) return

  const route = parseInternalLinkRoute(event.target)
  if (route) {
    event.preventDefault()
    openInternalPath({ ...route, doCreateNewTab: true })
  }
}

/**
 * @param {PointerEvent} event
 */
function handleLinkClick(event) {
  const href = event.target.href
  event.preventDefault()

  // Check if it's a YouTube link, but exclude live chat pop out
  const youtubeUrlPattern = /^https?:\/\/((www\.)?youtube\.com(\/embed)?|youtu\.be)\/(?!.*live_chat).*$/
  const isYoutubeLink = youtubeUrlPattern.test(href)

  if (isYoutubeLink) {
    // `auxclick` is the event type for non-left click
    // https://developer.mozilla.org/en-US/docs/Web/API/Element/auxclick_event
    if (enableTabs.value && event.type === 'auxclick') {
      handleYoutubeLink(href, {
        doCreateNewTab: true
      })
    } else {
      handleYoutubeLink(href, {
        doCreateNewWindow: event.type === 'auxclick'
      })
    }
  } else if (externalLinkHandling.value === 'doNothing') {
    // Let user know opening external link is disabled via setting
    showToast(t('External link opening has been disabled in the general settings'))
  } else if (externalLinkHandling.value === 'openLinkAfterPrompt') {
    // Storing the URL is necessary as
    // there is no other way to pass the URL to click callback
    lastExternalLinkToBeOpened.value = href
    showExternalLinkOpeningPrompt.value = true
  } else {
    // Open links externally
    openExternalLink(href)
  }
}

async function handleYoutubeLink(href, { doCreateNewWindow = false, doCreateNewTab = false } = {}) {
  const result = await store.dispatch('getYoutubeUrlInfo', href)

  switch (result.urlType) {
    case 'video': {
      const { videoId, timestamp, playlistId } = result

      const query = {}
      if (timestamp) {
        query.timestamp = timestamp
      }
      if (playlistId && playlistId.length > 0) {
        query.playlistId = playlistId
      }

      openInternalPath({
        path: `/watch/${videoId}`,
        query,
        doCreateNewWindow,
        doCreateNewTab
      })
      break
    }

    case 'playlist': {
      const { playlistId, query } = result

      openInternalPath({
        path: `/playlist/${playlistId}`,
        query,
        doCreateNewWindow,
        doCreateNewTab
      })
      break
    }

    case 'search': {
      const { searchQuery, query } = result

      openInternalPath({
        path: `/search/${encodeURIComponent(searchQuery)}`,
        query,
        doCreateNewWindow,
        doCreateNewTab,
        searchQueryText: searchQuery
      })
      break
    }

    case 'hashtag': {
      const { hashtag } = result
      openInternalPath({
        path: `/hashtag/${encodeURIComponent(hashtag)}`,
        doCreateNewWindow,
        doCreateNewTab
      })
      break
    }

    case 'post': {
      const { postId, query } = result

      openInternalPath({
        path: `/post/${postId}`,
        query,
        doCreateNewWindow,
        doCreateNewTab
      })
      break
    }

    case 'channel': {
      const { channelId, subPath, url } = result

      openInternalPath({
        path: `/channel/${channelId}/${subPath}`,
        doCreateNewWindow,
        doCreateNewTab,
        query: {
          url
        }
      })
      break
    }

    case 'trending':
    case 'subscriptions':
    case 'history':
    case 'userplaylists':
      openInternalPath({
        path: `/${result.urlType}`,
        doCreateNewWindow,
        doCreateNewTab
      })
      break

    case 'invalid_url': {
      // Do nothing
      break
    }

    default: {
      // Unknown URL type
      showToast(t('Unknown YouTube url type, cannot be opened in app'))
    }
  }
}

function enableOpenUrl() {
  window.ftElectron.handleOpenUrl((url) => {
    if (url) {
      handleYoutubeLink(url, {
        doCreateNewTab: enableTabs.value
      })
    }
  })
}

function enableOpenInNewTab() {
  window.ftElectron.handleOpenInNewTab((linkURL) => {
    if (!enableTabs.value) return

    const route = parseAppLinkUrl(linkURL)
    if (!route) return

    openInternalPath({ ...route, doCreateNewTab: true })
  })
}

const windowTitle = computed(() => {
  const routePath = route.path
  if (
    !routePath.startsWith('/channel/') &&
    !routePath.startsWith('/watch/') &&
    !routePath.startsWith('/hashtag/') &&
    !routePath.startsWith('/playlist/') &&
    !routePath.startsWith('/search/')
  ) {
    let title = translateWindowTitle(route.meta.title)
    if (!title) {
      title = packageDetails.productName
    } else {
      title = `${title} - ${packageDetails.productName}`
    }
    return title
  } else {
    return null
  }
})

/** @type {import('vue').ComputedRef<string>} */
const appTitle = computed(() => store.getters.getAppTitle)

watch(appTitle, (value) => {
  document.title = value
})

watch(activeTabId, () => {
  if (enableTabs.value) {
    const activeTab = store.getters['tabs/getActiveTab']
    if (activeTab && activeTab.title) {
      const title = `${activeTab.title} - ${packageDetails.productName}`
      store.commit('setAppTitle', title)
    }
  }
})

watch(windowTitle, setWindowTitle)

function setWindowTitle() {
  if (windowTitle.value !== null) {
    store.commit('setAppTitle', windowTitle.value)
  }
}

const isLocaleRightToLeft = computed(() => {
  const locale_ = locale.value

  return locale_ === 'ar' || locale_ === 'fa' || locale_ === 'he' ||
  locale_ === 'ur' || locale_ === 'yi' || locale_ === 'ku'
})

watch(locale, (value) => {
  document.documentElement.lang = value

  document.body.dir = isLocaleRightToLeft.value ? 'rtl' : 'ltr'
}, { immediate: true })

// en-US is the fallback locale, which means we always need it
// regardless of the user's settings so we can already start start loading it now
loadLocale('en-US')

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

/**
 * Transforms dragged in-app URLs into YouTube ones, so they they can be dragged into other applications.
 * Cancels the drag operation if the URL is FreeTube specific and cannot be transformed e.g. user playlist URLs
 * @param {DragEvent} event
 */
function handleDragStart(event) {
  if (!event.dataTransfer.types.includes('text/uri-list')) {
    return
  }

  const originalUrlString = event.dataTransfer.getData('text/uri-list')
  const originalUrl = new URL(originalUrlString)

  // Check if this is an in-app URL
  if (originalUrl.origin !== window.location.origin || originalUrl.pathname !== window.location.pathname) {
    return
  }

  const [path, query] = originalUrl.hash.slice(2).split('?')
  const pathParts = path.split('/')
  const params = new URLSearchParams(query)

  let transformed = false
  let transformedURL = new URL('https://www.youtube.com')

  switch (pathParts[0]) {
    case 'watch':
      transformedURL.pathname = '/watch'
      transformedURL.searchParams.set('v', pathParts[1])

      if (params.has('timestamp')) {
        transformedURL.searchParams.set('t', params.get('timestamp') + 's')
      }

      if (params.has('playlistId') && params.get('playlistType') !== 'user') {
        transformedURL.searchParams.set('list', params.get('playlistId'))
      }

      transformed = true
      break
    case 'playlist':
      if (params.get('playlistType') !== 'user') {
        transformedURL.pathname = '/playlist'
        transformedURL.searchParams.set('list', pathParts[1])

        transformed = true
      }
      break
    case 'channel':
      transformedURL.pathname = `/channel/${pathParts[1]}`

      if (pathParts[2]) {
        switch (pathParts[2]) {
          case 'community':
            transformedURL.pathname += '/posts'
            break
          case 'search':
            transformedURL.pathname += '/search'
            if (params.has('searchQueryText')) {
              transformedURL.searchParams.set('query', params.get('searchQueryText'))
            }
            break
          case 'videos':
          case 'shorts':
          case 'releases':
          case 'podcasts':
          case 'courses':
          case 'playlists':
          case 'about':
            transformedURL.pathname += `/${pathParts[2]}`
            break
        }
      }

      transformed = true
      break
    case 'search':
      transformedURL.pathname = '/results'
      transformedURL.searchParams.set('search_query', decodeURIComponent(pathParts[1]))
      transformed = true
      break
    case 'hashtag':
    case 'post':
      transformedURL.pathname = `/${pathParts[0]}/${pathParts[1]}`
      transformed = true
      break
    case 'subscriptions':
    case 'history':
      transformedURL.pathname = `/feed/${pathParts[1]}`
      transformed = true
      break
    case 'userplaylists':
      transformedURL.pathname = '/feed/playlists'
      transformed = true
      break
    case 'settings':
      transformedURL.pathname = '/account'
      transformed = true
      break
    case 'about':
      transformedURL.pathname = '/about'
      transformed = true
      break
    case 'popular':
      transformedURL = new URL(`${currentInvidiousInstanceUrl.value}/feed/popular`)
      transformed = true
      break
  }

  if (transformed) {
    const transformedURLString = transformedURL.toString()

    event.dataTransfer.setData('text/uri-list', transformedURLString)

    const plainText = event.dataTransfer.getData('text/plain')
    if (plainText.length > 0) {
      event.dataTransfer.setData('text/plain', plainText.replaceAll(originalUrlString, transformedURLString))
    }

    const html = event.dataTransfer.getData('text/html')
    if (html.length > 0) {
      const originalUrlStringEncoded = originalUrlString.replaceAll('&', '&amp;')
      const transformedURLStringEncoded = transformedURLString.replaceAll('&', '&amp;')

      event.dataTransfer.setData('text/html', html.replaceAll(originalUrlStringEncoded, transformedURLStringEncoded))
    }
  } else {
    // Cancel the drag operation for FreeTube specific URLs that cannot be transformed such as user playlist URLs
    event.preventDefault()
    event.stopPropagation()
  }
}
</script>

<style src="./themes.css" />
<style scoped src="./App.css" />
