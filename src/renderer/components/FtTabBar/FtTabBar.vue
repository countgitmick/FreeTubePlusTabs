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
</template>

<script setup>
import { computed, ref, useTemplateRef } from 'vue'
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
