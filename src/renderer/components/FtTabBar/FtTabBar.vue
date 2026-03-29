<template>
  <div
    class="tabBar"
    @dragenter.prevent
    @dragover.prevent
    @drop.prevent
  >
    <div
      ref="tabListRef"
      class="tabList"
      role="tablist"
      tabindex="-1"
      @wheel.prevent="handleWheel"
      @dragenter.prevent
      @dragover.prevent
      @drop.prevent.stop="handleDropOutside"
    >
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        role="tab"
        tabindex="0"
        :class="{
          activeTab: tab.id === activeTabId,
          dragging: dragTabId === tab.id,
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
        @dragenter.prevent
        @dragover.prevent="handleDragOver($event, tab.id)"
        @drop.prevent="handleDrop($event, tab.id)"
        @dragend="handleDragEnd"
        @contextmenu.prevent="openContextMenu($event, tab.id)"
      >
        <FontAwesomeIcon
          class="tabIcon"
          :icon="['fas', mapIcon(tab.mediaPlaying ? 'playing' : tab.icon)]"
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
        @click="handleContextRefresh"
      >
        {{ t('Tab Context Menu.Refresh Tab') }}
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
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from '../../composables/use-i18n-polyfill'
import { useTabOperations } from '../../composables/use-tab-operations'

import store from '../../store/index'
import { KeyboardShortcuts } from '../../../constants'

const { t } = useI18n()
const { closeTab, closeOtherTabs, closeTabsToRight, switchToTab, createNewTab, duplicateTab } = useTabOperations()

const tabs = computed(() => store.getters['tabs/getTabs'])
const activeTabId = computed(() => store.getters['tabs/getActiveTabId'])

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

function handleContextCloseOthers() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return
  closeOtherTabs(tabId)
}

function handleContextCloseToRight() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return
  closeTabsToRight(tabId)
}

function handleContextRefresh() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return

  if (tabId === activeTabId.value) {
    // Active tab: dispatch a synthetic keypress to trigger the page's own refresh handler
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: KeyboardShortcuts.APP.SITUATIONAL.REFRESH,
      bubbles: true,
    }))
  } else {
    // Non-active tab: hard refresh via refreshKey (no keyboard handler is listening)
    store.commit('tabs/refreshTab', tabId)
  }
}

function handleContextDuplicate() {
  const tabId = contextMenuTabId.value
  closeContextMenu()
  if (!tabId) return
  duplicateTab(tabId)
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
  playing: 'volume-high',
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

function handleTabClick(tabId) {
  switchToTab(tabId)
}

function handleTabClose(tabId) {
  closeTab(tabId)
}

const dragTabId = ref(null)
const dragOverTabId = ref(null)

function handleDragStart(event, tabId) {
  dragTabId.value = tabId
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-ft-tab', tabId)
  event.stopPropagation()
}

function handleDragOver(event, tabId) {
  if (dragTabId.value === null || dragTabId.value === tabId) return
  event.dataTransfer.dropEffect = 'move'
  dragOverTabId.value = tabId
}

function handleDrop(event, tabId) {
  event.stopPropagation()
  if (dragTabId.value === null || dragTabId.value === tabId) return
  const srcId = dragTabId.value
  // Clear drag state BEFORE Vuex commit — the commit triggers a synchronous
  // Vue re-render that moves DOM nodes, which fires synthetic dragover events.
  // If dragTabId is still set, handleDragOver processes those events, updates
  // dragOverTabId, triggers another re-render, and loops until the app freezes.
  dragTabId.value = null
  dragOverTabId.value = null
  const tabsCopy = [...tabs.value]
  const fromIdx = tabsCopy.findIndex(t => t.id === srcId)
  const toIdx = tabsCopy.findIndex(t => t.id === tabId)
  if (fromIdx === -1 || toIdx === -1) return
  const [moved] = tabsCopy.splice(fromIdx, 1)
  tabsCopy.splice(toIdx, 0, moved)
  store.commit('tabs/reorderTabs', tabsCopy)
  store.dispatch('tabs/persistTabs')
}

function handleDropOutside(event) {
  event.stopPropagation()
  dragTabId.value = null
  dragOverTabId.value = null
}

function handleDragEnd() {
  dragTabId.value = null
  dragOverTabId.value = null
}

function handleNewTab() {
  createNewTab()
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
