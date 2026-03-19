<p align="center">
 <img alt="" src="/_icons/logoColor.svg" width=500 align="center">
</p>

<h2 align="center">FreeTube + Tabs</h2>

<p align="center">
The #1 most requested FreeTube feature, finally built.<br>
Everything you love about FreeTube, with browser-like tabs.
</p>

<hr>

## The Problem Everyone Knows About

If you use FreeTube, you already know the pain. You're watching a video, want to check a channel, look up another video, and come back to what you were watching. But FreeTube forces you into one view at a time. You lose your place. You lose your scroll position. You lose your flow.

**Over 7 years, [hundreds of users asked for tabs](https://github.com/FreeTubeApp/FreeTube/issues/333).** Duplicate issues were opened and closed. The feature sat at the top of every wishlist. No one built it.

Until now.

## What You Get

FreeTube + Tabs is a fork of FreeTube that adds one thing: real, browser-style tabs. Nothing else changes. You keep all your privacy, all your features, all your data.

**Tabs that actually work:**
- Open any video, channel, or search in a new tab (middle-click or Ctrl+click)
- Switch between tabs without losing your place (scroll position, video timestamp, everything preserved)
- Only the active tab plays audio (no surprise sound from background tabs)
- Drag tabs to reorder them
- Pin tabs you want to keep
- Keyboard shortcuts you already know: `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+1-9`
- Right-click tab menu: Close, Close Others, Close to Right, Duplicate
- Your tabs restore when you reopen the app

**Everything else is stock FreeTube:**
- Same privacy protections
- Same ad-free experience
- Same Local API and Invidious support
- Same subscriptions, playlists, and history
- Same SponsorBlock and DeArrow
- Regular syncs from upstream FreeTube

## Why This Fork Exists

The upstream project explored three paths for tabs and hit dead ends on all of them:

| Approach | Why it failed |
|----------|--------------|
| `electron-tabs` library | Uses deprecated Electron `<webview>` tags. Library archived Jan 2024. |
| Switch to Tauri | CORS is a dealbreaker. System webview fragmentation. Maintainers ruled it out permanently. |
| Wait for Electron native tabs | Only exists on macOS. No cross-platform API planned. |

**This fork takes the fourth path**: tabs as a pure Vue.js feature inside the existing app. No new dependencies. No Electron hacks. The same approach VS Code, Notion, and Discord use for their tabs.

## Download

**Releases**: [GitHub Releases](../../releases)

Available for Windows, Mac, and Linux (same platforms as FreeTube).

> Already using FreeTube? Your existing data (subscriptions, playlists, history, settings) works as-is. Just install and go.

## Staying Up to Date

This fork regularly merges from upstream FreeTube. You get every bug fix, every YouTube adaptation, every new feature. Tabs are additive; they don't conflict with upstream changes.

## Screenshots

*Coming soon: screenshots showing the tab bar in action.*

## FAQ

**Will my FreeTube data carry over?**
Yes. Subscriptions, playlists, history, and settings are fully compatible. Install this fork and everything is already there.

**Can I go back to regular FreeTube?**
Yes. Your data is untouched. Uninstall this, install upstream FreeTube, done.

**How many tabs can I open?**
Default limit is 20 (configurable in settings). Each tab holds its state in memory, so the limit keeps things responsive.

**Does this break multi-window?**
No. Multi-window still works the same way. Tabs and windows are independent features.

**Why not contribute this upstream?**
FreeTube's contribution guidelines do not currently accept this type of contribution. This fork exists so the feature is available to everyone regardless.

## Credits

FreeTube + Tabs is built on top of [FreeTube](https://github.com/FreeTubeApp/FreeTube) by the FreeTube team. All credit for the core application goes to them. This fork adds the tab feature only.

See the full list of [People and Projects](https://docs.freetubeapp.io/credits/) that make FreeTube possible.

## License
[![GNU AGPLv3 Image](https://www.gnu.org/graphics/agplv3-155x51.png)](https://www.gnu.org/licenses/agpl-3.0.html)

FreeTube + Tabs is Free Software under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html), the same license as upstream FreeTube.
