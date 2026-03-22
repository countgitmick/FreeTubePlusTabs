<template>
  <div class="tabBar">
    <div
      ref="tabListRef"
      class="tabList"
      role="tablist"
      @wheel.prevent="handleWheel"
    >
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        role="tab"
        tabindex="0"
        :class="{
          activeTab: tab.id === activeTabId,
          dragOver: dragOverTabId === tab.id && dragTabId !== tab.id,
        }"
        :title="tab.title"
        :aria-label="tab.title"
        :aria-selected="tab.id === activeTabId"
        draggable="true"
        @click="handleTabClick(tab.id)"
        @keydown.enter.prevent="handleTabClick(tab.id)"
        @keydown.space.prevent="handleTabClick(tab.id)"
        @mouseup.middle.prevent="handleTabClose(tab.id)"
        @dragstart="handleDragStart($event, tab.id)"
        @dragover.prevent="handleDragOver($event, tab.id)"
        @drop="handleDrop($event, tab.id)"
        @dragend="handleDragEnd"
        @contextmenu.prevent="openContextMenu($event, tab.id)"
      >
        <FontAwesomeIcon
          class="tabIcon"
          :icon="['fas', mapIcon(tab.icon)]"
        />
        <span class="tabTitle">{{ tab.title }}</span>
        <button
          class="tabCloseBtn"
          :aria-label="t('Close')"
          :title="t('Close')"
          @click.stop="handleTabClose(tab.id)"
        >
          <FontAwesomeIcon
            :icon="['fas', 'times']"
            class="tabCloseIcon"
          />
        </button>
      </div>
    </div>
    <button
      class="newTabBtn"
      :title="t('Open New Window')"
      @click="handleNewTab"
    >
      <FontAwesomeIcon
        :icon="['fas', 'plus']"
        class="newTabIcon"
      />
    </button>
  </div>
  <Teleport to="body">
    <div
      v-if="contextMenuVisible"
      ref="contextMenuRef"
      class="tabContextMenu"
      :style="{ top: contextMenuPosition.y + 'px', left: contextMenuPosition.x + 'px' }"
      @contextmenu.prevent
    >
      <button
        class="tabContextMenuItem"
        @click="handleContextClose"
      >
        {{ t('Tab Context Menu.Close Tab') }}
      </button>
      <button
        class="tabContextMenuItem"
        :disabled="tabs.length <= 1"
        @click="handleContextCloseOthers"
      >
        {{ t('Tab Context Menu.Close Other Tabs') }}
      </button>
      <button
        class="tabContextMenuItem"
        :disabled="isRightmostTab"
        @click="handleContextCloseToRight"
      >
        {{ t('Tab Context Menu.Close Tabs to Right') }}
      </button>
      <button
        class="tabContextMenuItem"
        @click="handleContextDuplicate"
      >
        {{ t('Tab Context Menu.Duplicate Tab') }}
      </button>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from '../../composables/use-i18n-polyfill'

import store from '../../store/index'

const { t } = useI18n()
const router = useRouter()

const tabs = computed(() => store.getters['tabs/getTabs'])
const activeTabId = computed(() => store.getters['tabs/getActiveTabId'])
const landingPage = computed(() => '/' + store.getters.getLandingPage)

const tabListRef = useTemplateRef('tabListRef')
const contextMenuRef = useTemplateRef('contextMenuRef')

const contextMenuVisible = ref(false)
const contextMenuTabId = ref(null)
const contextMenuPosition = ref({ x: 0, y: 0 })

const isRightmostTab = computed(() => {
  if (!contextMenuTabId.value) return true
  const idx = tabs.value.findIndex(t => t.id === contextMenuTabId.value)
  return idx === tabs.value.length - 1
})

function openContextMenu(event, tabId) {
  contextMenuTabId.value = tabId
  contextMenuPosition.value = { x: event.clientX, y: event.clientY }
  contextMenuVisible.value = true

  nextTick(() => {
    const menu = contextMenuRef.value
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      contextMenuPosition.value.x = window.innerWidth - rect.width - 4
    }
    if (rect.bottom > window.innerHeight) {
      contextMenuPosition.value.y = window.innerHeight - rect.height - 4
    }
  })
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuTabId.value = null
}

function handleContextClose() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (tabId) handleTabClose(tabId)
}

async function handleContextCloseOthers() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return

  store.dispatch('tabs/closeOtherTabs', tabId)

  // If the active tab was closed, navigate to the kept tab
  if (activeTabId.value !== tabId) {
    const tab = store.getters['tabs/getTabById'](tabId)
    if (tab) {
      window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
      try {
        await router.replace({ path: tab.route.path, query: tab.route.query })
      } finally {
        window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
      }
    }
  }
  store.dispatch('tabs/persistTabs')
}

async function handleContextCloseToRight() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return

  // Check if active tab is to the right and will be removed
  const idx = tabs.value.findIndex(t => t.id === tabId)
  const activeIdx = tabs.value.findIndex(t => t.id === activeTabId.value)
  const activeWillBeRemoved = activeIdx > idx

  store.dispatch('tabs/closeTabsToRight', tabId)

  if (activeWillBeRemoved) {
    const tab = store.getters['tabs/getTabById'](tabId)
    if (tab) {
      window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
      try {
        await router.replace({ path: tab.route.path, query: tab.route.query })
      } finally {
        window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
      }
      store.commit('tabs/setActiveTabId', tabId)
    }
  }
  store.dispatch('tabs/persistTabs')
}

async function handleContextDuplicate() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return

  const newTab = await store.dispatch('tabs/duplicateTab', tabId)
  if (newTab) {
    window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
    try {
      await router.replace({ path: newTab.route.path, query: newTab.route.query })
    } finally {
      window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
    }
  }
}

function onClickOutside(event) {
  if (contextMenuVisible.value && contextMenuRef.value && !contextMenuRef.value.contains(event.target)) {
    closeContextMenu()
  }
}

function onKeydownEscape(event) {
  if (event.key === 'Escape' && contextMenuVisible.value) {
    closeContextMenu()
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside, true)
  document.addEventListener('keydown', onKeydownEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside, true)
  document.removeEventListener('keydown', onKeydownEscape)
})

function handleWheel(event) {
  if (tabListRef.value) {
    tabListRef.value.scrollLeft += event.deltaY
  }
}

const iconMap = {
  play: 'play',
  user: 'user',
  search: 'search',
  rss: 'rss',
  fire: 'fire',
  history: 'clock-rotate-left',
  cog: 'gear',
  list: 'list',
  hashtag: 'hashtag',
  home: 'home',
}

function mapIcon(icon) {
  return iconMap[icon] || 'home'
}

async function handleTabClick(tabId) {
  if (tabId === activeTabId.value) return

  const targetRoute = await store.dispatch('tabs/switchTab', tabId)
  if (targetRoute) {
    window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
    try {
      await router.replace({ path: targetRoute.path, query: targetRoute.query })
      // Commit activeTabId AFTER route is updated so component remounts with correct route
      store.commit('tabs/setActiveTabId', tabId)
      store.dispatch('tabs/persistTabs')
    } finally {
      // Clear guard AFTER setActiveTabId so afterEach hook doesn't misfire
      window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
    }

    // Restore scroll position after navigation settles
    const tab = store.getters['tabs/getTabById'](tabId)
    if (tab && tab.scrollPosition) {
      requestAnimationFrame(() => {
        const scrollEl = document.querySelector('.flexBox.routerView')
        if (scrollEl) {
          scrollEl.scrollTo(tab.scrollPosition.x, tab.scrollPosition.y)
        }
      })
    }
  }
}

async function handleTabClose(tabId) {
  const result = await store.dispatch('tabs/closeTab', tabId)
  if (result) {
    window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
    try {
      await router.replace({ path: result.route.path, query: result.route.query })
    } finally {
      window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
    }
    store.commit('tabs/setActiveTabId', result.tabId)
    store.dispatch('tabs/persistTabs')
  }
}

const dragTabId = ref(null)
const dragOverTabId = ref(null)

function handleDragStart(event, tabId) {
  dragTabId.value = tabId
  event.dataTransfer.effectAllowed = 'move'
}

function handleDragOver(event, tabId) {
  if (dragTabId.value === null || dragTabId.value === tabId) return
  event.dataTransfer.dropEffect = 'move'
  dragOverTabId.value = tabId
}

function handleDrop(event, tabId) {
  if (dragTabId.value === null || dragTabId.value === tabId) return
  const tabsCopy = [...tabs.value]
  const fromIdx = tabsCopy.findIndex(t => t.id === dragTabId.value)
  const toIdx = tabsCopy.findIndex(t => t.id === tabId)
  const [moved] = tabsCopy.splice(fromIdx, 1)
  tabsCopy.splice(toIdx, 0, moved)
  store.commit('tabs/reorderTabs', tabsCopy)
  store.dispatch('tabs/persistTabs')
  dragTabId.value = null
  dragOverTabId.value = null
}

function handleDragEnd() {
  dragTabId.value = null
  dragOverTabId.value = null
}

async function handleNewTab() {
  window.__tabSwitchNavCount = (window.__tabSwitchNavCount || 0) + 1
  try {
    await router.replace({ path: landingPage.value })
  } finally {
    window.__tabSwitchNavCount = Math.max(0, (window.__tabSwitchNavCount || 0) - 1)
  }
  store.dispatch('tabs/createTab', {
    route: { path: landingPage.value, query: {} },
    makeActive: true,
  })
}
</script>

<style scoped src="./FtTabBar.css" />

<style>
.tabContextMenu {
  position: fixed;
  z-index: 10000;
  min-inline-size: 180px;
  background-color: var(--side-nav-color);
  border: 1px solid var(--tertiary-text-color);
  border-radius: 4px;
  padding-block: 4px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 30%);
}

.tabContextMenuItem {
  display: block;
  inline-size: 100%;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--primary-text-color);
  font-size: 13px;
  text-align: start;
  cursor: pointer;
  white-space: nowrap;
}

.tabContextMenuItem:hover:not(:disabled) {
  background-color: var(--side-nav-hover-color);
}

.tabContextMenuItem:disabled {
  color: var(--tertiary-text-color);
  cursor: default;
}
</style>
