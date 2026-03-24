# Contributing to FreeTube + Tabs

This is **FreeTube + Tabs**, a fork of FreeTube that adds browser-style tabs.
All issues and contributions should be directed to this fork's repository,
not to upstream FreeTube. If upstream wants to adopt this implementation,
the code is available under the same AGPL-3.0 license.

## Reporting Issues

- Report **all** issues to [this fork's issue tracker](../../issues), not upstream FreeTube.
- Tab-related or not — if you're running this fork, report here.
- Check existing issues before opening a new one.
- Include your OS, app version, and steps to reproduce.

## Before You Start Coding

- If you want to fix an existing issue, comment on it first so we can coordinate.
- If you want to add a feature, open an issue first to discuss it.
- For tab-related changes, read [DESIGN-TABS.md](DESIGN-TABS.md) to understand the architecture.

## Code Standards

### Style

- Follow the existing code style. When in doubt, look at surrounding code.
- Use ES6+ conventions: `const`/`let` (never `var`), arrow functions for callbacks, template literals.
- Follow [Vue 3 Composition API](https://vuejs.org/guide/introduction.html) patterns for new components. Existing Options API components don't need to be migrated.
- Comment only when the logic isn't self-evident. Don't add JSDoc to every function.

### Linting

ESLint and Stylelint are enforced via pre-commit hooks (lefthook). Your code must pass before it can be committed.

```bash
# Check for issues
yarn run lint

# Auto-fix what can be fixed
yarn run lint-fix
```

Key rules to know:
- `console.log` and `console.info` are banned — use `console.warn` or `console.error` only.
- `v-html` is banned — use the `v-safer-html` directive (DOMPurify-backed).
- Accessibility attributes (`aria-label`, `title`, `alt`) must use i18n translations, not hardcoded strings.

### Testing

- There is no automated test suite yet. Manual testing is required.
- Test with both the Local API and Invidious API.
- Test tab-specific behavior: open in new tab, switch tabs, close tabs, idle timeout, restore on restart.
- If your change touches the player, test: play/pause across tabs, picture-in-picture, fullscreen.

### Dependencies

- Do **not** add new Node modules unless absolutely necessary.
- The tab system was specifically designed to require zero new dependencies. Keep it that way.

## Tab System Guidelines

If your change touches the tab system, follow these principles:

- **Tabs are hidden, not destroyed.** Active tabs use `v-show`, not `v-if`. Component state is preserved via `<keep-alive>`.
- **Idle tabs are destroyed after 15 minutes** (configurable). Tabs with playing media are exempt.
- **Each tab has its own navigation history.** Back/forward are per-tab, not global.
- **State lives in Vuex.** The `tabs` store module is the single source of truth. Don't store tab state in components.
- **Guard against tab-switch race conditions.** Use the `window.__tabSwitchInProgress` flag pattern with `try/finally`. See existing code in `App.vue` and `FtTabBar.vue`.
- **Use `structuredClone`** for deep copying tab/route objects, not `JSON.parse(JSON.stringify(...))`.

## Pull Requests

- Target the `development` branch.
- Make sure your branch is up to date with `development` before submitting.
- Keep PRs focused. One feature or fix per PR.
- By submitting a PR, you agree your code is published under the [GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

## Development Setup

### Prerequisites

- Node.js (see `.nvmrc` or `package.json` engines)
- Yarn

### Getting Started

```bash
git clone https://github.com/countgitmick/FreeTubePlusTabs.git
cd FreeTubePlusTabs
yarn install
yarn dev
```

### NixOS

```bash
nix run github:countgitmick/FreeTubePlusTabs
```

Or with the development shell:

```bash
nix develop
yarn install
yarn dev
```

### Project Structure

```
src/
  main/           # Electron main process
  preload/        # Context bridge (ftElectron API)
  renderer/       # Vue 3 SPA
    components/   # Vue components
      FtTabBar/   # Tab bar UI
      TabContent/ # Tab content lifecycle wrapper
    store/
      modules/
        tabs.js   # Tab state management
    views/        # Route views (Watch, Channel, etc.)
    helpers/      # Utilities and API clients
  datastores/     # NeDB persistence layer
  constants.js    # IPC channels, keyboard shortcuts
```

## Architecture Notes

- **Context isolation is enabled.** The renderer communicates with the main process exclusively through the `ftElectron` API exposed via `contextBridge` in the preload script. Never bypass this.
- **IPC handlers validate senders.** Every `ipcMain.handle`/`ipcMain.on` must check `isFreeTubeUrl(event.senderFrame.url)`.
- **No `eval` or `new Function`** except in the sandboxed BotGuard/sigFrame contexts (required for YouTube compatibility).
- **HTML sanitization uses `v-safer-html`**, which wraps DOMPurify. Never use `v-html` or raw `innerHTML` on user-facing content.
