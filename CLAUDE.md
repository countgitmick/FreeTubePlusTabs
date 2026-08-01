# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FreeTube + Tabs — a fork of FreeTube (Electron-based private YouTube client) that adds browser-style tab support. The tab system uses SPA-level tabs (single BrowserWindow, multiple Vue component instances), not Electron-level WebContentsView.

## Commands

This is a NixOS machine with no `node`, `npx`, or real `yarn` on PATH. Prefix every
command below with `nix shell nixpkgs#nodejs nixpkgs#yarn --command`. A bare
`yarn <script>` fails with `exec: npx: not found`.

```bash
yarn dev              # Dev server with HMR (port 9080). See the note below.
yarn build            # Production build for current platform
yarn lint             # ESLint + Stylelint in parallel
yarn lint-fix         # Auto-fix lint issues
yarn lint-all         # lint + lint-json
yarn eslint-lint      # ESLint only
yarn lint-style       # Stylelint only
yarn run pack         # Webpack bundle all (main, renderer, preload, botGuardScript)
yarn clean            # Remove build/ and dist/
```

`pack` needs `yarn run pack`. Yarn 1 has a built-in `pack` command that shadows the
script, and it writes a tarball in under a second instead of bundling anything.

`yarn dev` also needs the Electron binary replaced. The one that npm downloads is a
generic-linux prebuilt, and NixOS cannot execute it, so dev-runner stops at
`Could not start dynamically linked executable`. Both problems are handled by the
`./dev` script at the repo root:

```bash
./dev          # this is the way to start the dev server
```

It expands to:

```bash
nix shell nixpkgs#nodejs nixpkgs#yarn --command \
  env ELECTRON_OVERRIDE_DIST_PATH=$(nix build nixpkgs#electron --no-link --print-out-paths)/bin \
  yarn dev
```

No test framework is configured. Manual testing is required.

## Architecture

### Process Model (Electron)

- **Main process** (`src/main/index.js`): App lifecycle, IPC handlers, window management, NeDB database I/O
- **Renderer process** (`src/renderer/main.js`): Vue 3 SPA — all UI lives here
- **Preload script** (`src/preload/interface.js`): Context-isolated bridge exposing `window.ftElectron` for IPC

### Frontend Stack

- Vue 3 (Composition API + `<script setup>` for new code; existing Options API doesn't need migration)
- Vuex 4 (state management, strict mode OFF)
- Vue Router 5 (`createWebHashHistory`)
- vue-i18n 11 (all user-facing strings must use i18n, never hardcoded)

### Key Directories

| Path | Purpose |
|------|---------|
| `src/main/` | Electron main process |
| `src/renderer/views/` | Route-level page components |
| `src/renderer/components/` | Reusable UI components (75+ dirs) |
| `src/renderer/store/modules/` | Vuex modules (tabs, settings, history, playlists, etc.) |
| `src/renderer/helpers/api/` | Backend adapters (local.js = youtubei.js, invidious.js = REST) |
| `src/renderer/helpers/player/` | Shaka player plugins (SABR parser, segment parsers) |
| `src/renderer/composables/` | Vue 3 composable functions |
| `src/datastores/handlers/` | NeDB CRUD handlers per collection |
| `src/constants.js` | IPC channels, DB actions, keyboard shortcuts |
| `_scripts/` | Webpack configs, dev runner, build scripts |

### IPC Communication

IPC channels defined in `src/constants.js`. Patterns:
- `ipcRenderer.invoke()` → `ipcMain.handle()` (async request-response, primary pattern)
- `ipcRenderer.send()` / `ipcMain.on()` (fire-and-forget)

DB access flow: Renderer calls `window.ftElectron.dbXxx(action, data)` → IPC → main process handler → NeDB → response.

### Database

NeDB (embedded JSON database) stored in `app.getPath('userData')`. Collections: settings, profiles, history, playlists, search-history, subscription-cache, tabs.

### Player

Shaka Player 5 with custom plugins in `src/renderer/helpers/player/` for YouTube's SABR format, MP4/WebM segment index parsing, and EBML metadata.

### Routing

14 routes in `src/renderer/router/index.js`. Key routes: `/watch/:id`, `/channel/:id/:currentTab?`, `/playlist/:id`, `/search/:query`. When tabs are enabled, scroll behavior is handled per-tab by TabContent, not by the router.

## Tab System

Design doc: `DESIGN-TABS.md`. Core Vuex module: `src/renderer/store/modules/tabs.js`.

### Rules

- **Hide, don't destroy**: Tabs use `v-show` (not `v-if`); component state is preserved
- **Idle suspension**: Non-active tabs are hidden after 15 minutes; tabs with playing media are exempt
- **Per-tab state**: Each tab has its own route, navigation history stack, scroll position, and player state
- **Single audio**: Only one tab plays audio at a time
- **Tab-aware navigation**: Normal click navigates in active tab; Ctrl+click or middle-click opens new background tab
- **Race condition guard**: Tab switches use `window.__tabSwitchInProgress` flag
- **Graceful degradation**: With tabs disabled, app behaves like upstream FreeTube

### Key Tab Components

- `src/renderer/components/FtTabBar/` — Tab strip UI (draggable, context menu, overflow scroll)
- `src/renderer/components/TabContent/` — Per-tab content router with idle suspension

## Code Style

- **Indentation**: 2 spaces
- **Quotes**: Single quotes, no semicolons
- **ES6+**: const/let (no var), arrow functions, template literals
- **Console**: Only `console.warn` and `console.error` allowed — `console.log`/`.info`/`.debug` are ESLint errors
- **HTML safety**: `v-html` is banned — use the `v-safer-html` directive (DOMPurify-backed)
- **Accessibility**: Interactive elements need aria-label/title/alt via i18n keys
- **Vue reactive state**: Never use `structuredClone` on Vuex/Vue reactive objects (throws DataCloneError due to Proxy)

## Build System

Webpack 5 with separate configs for main, renderer, preload, and botGuardScript. Dev server (`_scripts/dev-runner.js`) orchestrates all four with HMR for renderer and file watching for main/preload.

Pre-commit hooks via lefthook: ESLint on `*.{js,vue}`, Stylelint on `*.{css,scss}`.

## Dual API Backend

The app supports two YouTube backends that should both be tested:
- **Local API**: Uses youtubei.js library (direct YouTube communication)
- **Invidious API**: REST API via public Invidious instances (fallback)
