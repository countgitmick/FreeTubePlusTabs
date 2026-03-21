# FreeTubePlusTabs: Browser-Like Tabs Design Document

## Overview

This fork adds browser-like tabs to FreeTube. Tabs are implemented as a pure Vue.js SPA feature using `<keep-alive>` for state preservation, requiring zero new dependencies and no Electron API changes.

Upstream issue: [FreeTubeApp/FreeTube#333](https://github.com/FreeTubeApp/FreeTube/issues/333) (open since 2019, no implementation attempts).

## Why SPA Tabs (Not Electron-Level)

| Approach | Verdict |
|----------|---------|
| `electron-tabs` | Archived (Jan 2024). Used deprecated `<webview>` tags. Hacky. |
| Tauri migration | Ruled out by maintainers (CORS blocker, webview fragmentation). |
| `WebContentsView` | Overkill for app rendering its own content. Creates IPC complexity. |
| **Vue SPA tabs** | **How VS Code, Notion, Discord do it. Zero dependencies. Shared state.** |

## Architecture

```
App.vue
├── TopNav (back/forward now per-tab)
├── FtTabBar (NEW - tab strip)
├── SideNav
└── <keep-alive> wrapping tab content (replaces bare <RouterView>)
```

All tabs live in a single renderer process. Each tab is a preserved Vue component instance. A new Vuex `tabs` store module tracks tab state.

## Tab State Shape

```js
// src/renderer/store/modules/tabs.js
{
  tabs: [
    {
      id: 'tab-uuid',
      route: { path: '/watch/dQw4w9WgXcQ', query: { playlistId: '...' } },
      title: 'Video Title',
      icon: 'video' | 'channel' | 'search' | ...,
      history: [route, ...],       // per-tab navigation stack
      historyIndex: 0,             // position in stack for back/forward
      scrollPosition: { x, y },
      pinned: false,
    }
  ],
  activeTabId: 'tab-uuid',
  maxTabs: 20,
}
```

Actions: `createTab`, `closeTab`, `switchTab`, `updateTabRoute`, `updateTabTitle`, `navigateBack`, `navigateForward`, `moveTab`, `pinTab`, `closeOtherTabs`, `closeTabsToRight`, `duplicateTab`

## Implementation Steps

### 1. Vuex tabs store module
**File**: `src/renderer/store/modules/tabs.js` (NEW)

Register in `src/renderer/store/index.js`.

### 2. Tab bar component
**File**: `src/renderer/components/ft-tab-bar/ft-tab-bar.vue` + `.js` + `.css` (NEW)

- Horizontal tab strip with draggable tabs
- Each tab: icon, truncated title, close button (x)
- Active tab highlighted
- "+" button opens new tab (default page from settings)
- Middle-click on tab to close
- Right-click context menu: Close, Close Others, Close to Right, Duplicate, Pin
- Drag to reorder (HTML5 drag or pointer events)
- Overflow: scroll with arrow buttons when tabs exceed width

### 3. Modify App.vue layout
**File**: `src/renderer/App.vue`

Replace `<RouterView>` with tab-aware content area using `<keep-alive>`:
```vue
<FtTabBar />
<div class="tab-content-area">
  <keep-alive :max="maxTabs">
    <component
      :is="activeTabComponent"
      :key="activeTabId"
      v-bind="activeTabProps"
    />
  </keep-alive>
</div>
```

### 4. Tab-aware navigation
**File**: `src/renderer/router/index.js` + components

Navigation behavior:
- **Normal click**: Navigate within active tab (push to tab's history stack)
- **Middle-click / Ctrl+click**: Open in new background tab
- **Shift+click**: Open in new foreground tab

Composable `useTabNavigation()`:
```js
function navigateTo(route, { newTab = false, background = false } = {}) {
  if (newTab) {
    store.dispatch('tabs/createTab', { route, activate: !background })
  } else {
    store.dispatch('tabs/updateTabRoute', { tabId: activeTabId, route })
  }
}
```

Replace `<router-link>` with `<ft-link>` wrapper that handles middle-click/ctrl+click.

### 5. Per-tab back/forward
**File**: `src/renderer/components/TopNav/TopNav.vue`

Replace `router.back()` / `router.forward()` with `store.dispatch('tabs/navigateBack')` / `store.dispatch('tabs/navigateForward')`. Enable/disable buttons based on active tab's history position.

### 6. Video player lifecycle
**File**: `src/renderer/views/Watch/Watch.vue` + `ft-shaka-video-player`

- `deactivated` hook: pause playback, save timestamp to tab state
- `activated` hook: restore scroll position (user manually resumes playback)
- Only one Shaka Player instance plays audio at a time

### 7. Tab title updates
**File**: Various view components

Each view updates tab title on content load:
- Watch: video title
- Channel: channel name
- Search: "Search: {query}"
- Static pages: "Subscriptions", "Settings", etc.

Composable calls `store.dispatch('tabs/updateTabTitle', title)`.

### 8. Keyboard shortcuts
**File**: `src/renderer/App.vue` or dedicated handler

- `Ctrl+T` - New tab
- `Ctrl+W` - Close active tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab` - Next/previous tab
- `Ctrl+1-9` - Switch to tab by index
- `Ctrl+Shift+T` - Reopen last closed tab (`recentlyClosed` stack)

### 9. Settings integration
**File**: `src/renderer/store/modules/settings.js`

- `enableTabs` (boolean, default: true)
- `maxTabs` (number, default: 20)
- `newTabPage` (string, default: 'subscriptions')

### 10. Multi-window sync
**File**: `src/main/index.js`, `src/constants.js`

Add `SYNC_TABS` IPC channel. Each window maintains its own tab set; shared state (history, playlists, settings) already syncs via existing IPC.

### 11. Session persistence
Persist open tabs to NeDB on close/periodic interval. Restore on startup. "Restore previous session" setting.

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/store/modules/tabs.js` | **NEW** - Tab state management |
| `src/renderer/store/index.js` | Register tabs module |
| `src/renderer/components/ft-tab-bar/*` | **NEW** - Tab bar UI |
| `src/renderer/App.vue` | Add tab bar, wrap content in keep-alive |
| `src/renderer/router/index.js` | Decouple from direct navigation |
| `src/renderer/components/TopNav/TopNav.vue` | Per-tab back/forward |
| `src/renderer/views/Watch/Watch.vue` | Pause/resume on tab switch |
| `src/renderer/components/ft-list-video/ft-list-video.vue` | Middle-click opens new tab |
| `src/renderer/store/modules/settings.js` | Tab-related settings |
| `src/constants.js` | New IPC channels for tab sync |

## Existing Code to Reuse

- **Multi-window IPC sync** (`settings.js:setupListenersToSyncWindows`) - same pattern for tab sync
- **`openInNewWindow(path, query)`** (`preload/interface.js`) - adapt to `openInNewTab`
- **Route definitions** (`router/index.js`) - reuse for tab route resolution
- **`watchVideoRouterLink`** (`ft-list-video.js`) - reuse route construction

## Key Considerations

- **Memory**: `<keep-alive>` holds all component state. Need `maxTabs` limit and LRU eviction for heavy components (video players).
- **Single audio**: Only the active tab's video should produce audio. Pause others on switch.
- **Scroll restoration**: Save/restore per-tab scroll position in `deactivated`/`activated` hooks.
- **Graceful degradation**: If `enableTabs` is false, app behaves exactly like upstream FreeTube.

## Verification

1. `yarn install && yarn run dev`
2. `yarn run lint` passes
3. Tab bar appears with one default tab
4. Click video navigates within tab; back/forward work per-tab
5. Middle-click video opens background tab
6. Switching tabs preserves content (scroll, video position)
7. Last tab can't be closed (opens new default tab instead)
8. Keyboard shortcuts work
9. Multiple Watch tabs: only active one plays audio
10. Both Local API and Invidious API backends work
11. Multi-window still works alongside tabs
