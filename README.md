<p align="center">
 <img alt="FreeTube + Tabs" src="/_icons/icon.svg" width=64 align="center">
</p>

<h1 align="center">FreeTube + Tabs</h1>

<h4 align="center">Ad-Free YouTube Client with Tabbed Browsing</h4>

<p align="center">
An ad-free YouTube desktop app with browser-style tabs.<br>
No ads, no tracking scripts, no Google account required. Open videos, channels, and searches in tabs.
</p>

<hr>

## The Problem Everyone Knows About

If you use FreeTube, you already know the pain. You're watching a video, want to check a channel, look up another video, and come back to what you were watching. But FreeTube forces you into one view at a time. You lose your place. You lose your scroll position. You lose your flow.

**For years, [users have asked for tabs](https://github.com/FreeTubeApp/FreeTube/issues/333).** Duplicate issues were opened and closed. The feature sat at the top of every wishlist. No one built it.

Until now.

<p align="center">
 <img alt="FreeTube + Tabs showing multiple open tabs" src="/_icons/preview.png" width=800>
</p>

## What You Get

FreeTube + Tabs is a fork of FreeTube that adds browser-style tabs and additional Linux desktop integration (hardware video decode, system media controls). All existing FreeTube features, data, and settings are preserved.

**Tabs that actually work:**
- Open any video, channel, or search in a new tab (middle-click)
- Switch between tabs without losing your place (scroll position, video timestamp, everything preserved)
- Background tabs pause when you play another video
- Drag tabs to reorder them
- Keyboard shortcuts you already know: `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+1-9`
- Right-click tab menu: Close, Close Others, Close to Right, Duplicate
- Your tabs restore when you reopen the app

**Everything else is stock FreeTube:**
- No ads, no tracking scripts, no Google login
- Local API (youtubei.js) and Invidious support
- Subscriptions, playlists, and history carry over from FreeTube
- SponsorBlock and DeArrow
- Merged from upstream FreeTube on each release

## Why This Fork Exists

The upstream community [discussed several approaches](https://github.com/FreeTubeApp/FreeTube/issues/333) for tabs:

| Approach | Status |
|----------|--------|
| `electron-tabs` library | Used Electron `<webview>` tags (recommended against by Electron). Library archived Jan 2024. |
| Switch to Tauri | CORS blocks YouTube API requests. System webview fragmentation. Maintainers have said Tauri is not viable. |
| Electron native tabs | macOS only. No cross-platform API. |

**This fork takes a different path**: tabs as a Vue.js SPA feature inside the existing renderer. No new dependencies for the tab system. No Electron-specific tab APIs. Architecturally similar to how VS Code and Notion handle tabs (multiple views in a single renderer process).

## Download

**Releases**: [GitHub Releases](../../releases)

Available for Windows, Mac, and Linux (same platforms as FreeTube).

> Already using FreeTube? Your existing data (subscriptions, playlists, history, settings) works as-is. Just install and go.

### Flatpak

Download the `.flatpak` bundle from the [latest release](../../releases/latest), then install:

```bash
# Install the bundle
flatpak install --user freetube-plus-tabs-*-linux-x86_64.flatpak

# Run it
flatpak run io.github.countgitmick.FreeTubePlusTabs
```

To update, download the new `.flatpak` bundle and install it again — Flatpak handles the upgrade automatically.

To uninstall:

```bash
flatpak uninstall --user io.github.countgitmick.FreeTubePlusTabs
```

### NixOS (Flake)

```bash
# Try it
nix run github:countgitmick/FreeTubePlusTabs

# Add to your flake.nix inputs
inputs.freetube-plus-tabs.url = "github:countgitmick/FreeTubePlusTabs";

# Then in your system packages
environment.systemPackages = [ inputs.freetube-plus-tabs.packages.${pkgs.system}.default ];
```

## Staying Up to Date

This fork merges from upstream FreeTube with each release. The tab system is implemented as an additive Vue component layer and has not required changes to upstream code paths so far.

## Privacy Model

This app does not run YouTube's tracking scripts, does not store cookies, does not require a Google account, and has no telemetry or analytics of its own.

However, it communicates directly with YouTube's servers (googlevideo.com, youtube.com, ytimg.com) to fetch video streams, thumbnails, and API data. YouTube can see your IP address and what you watch. This is the same model as Invidious, NewPipe, and yt-dlp. If you need IP-level privacy, use a VPN or Tor.

## Security

This fork inherits FreeTube's Electron security posture and adds hardening on top:

- `contextIsolation: true` (Electron default, explicitly set)
- `nodeIntegration: false` (explicitly set)
- IPC surface area restricted to a context-bridged preload with action allowlists
- Permission handlers verify both the requesting origin and the embedding frame chain
- Content Security Policy on all renderer HTML

**Known trade-off:** `webSecurity` (same-origin policy) is disabled because the renderer makes direct cross-origin requests to YouTube's CDNs. This is inherited from upstream FreeTube and is a structural requirement of the current architecture. Removing it would require proxying all media requests through a custom protocol handler, which is tracked as future work.

## FAQ

**Will my FreeTube data carry over?**
Yes. Subscriptions, playlists, history, and settings are fully compatible. Install this fork and everything is already there.

**Can I run this alongside regular FreeTube?**
No. This fork replaces FreeTube — they share the same data directory by design.
Uninstall one before installing the other. Your data (subscriptions, playlists,
history) carries over in both directions.

**Can I go back to regular FreeTube?**
Yes. Your data is untouched. Uninstall this, install upstream FreeTube, done.

**How many tabs can I open?**
Default limit is 20 (configurable in settings). Each tab holds its state in memory, so the limit keeps things responsive.

**Does this break multi-window?**
No. Multi-window still works the same way. Tabs and windows are independent features.

**Where do I report bugs?**
Report all issues to [this fork's issue tracker](../../issues), not to upstream FreeTube.
Tab-related or not — if you're running this fork, report here.

**Why not contribute this upstream?**
This feature is not being accepted upstream at this time. This fork exists so tabs are available to everyone regardless.

## Support This Project

If FreeTube + Tabs saves you time, consider supporting development. Donations go toward maintaining this fork, keeping it in sync with upstream, and building new features.

**Monero (XMR):**
```
473aJKYE7YRX2eWQfPqhaEh6EV9ZrQxyWUWEEyy6KrnraSPEQXAzwNaHBN7EsqVLMFUocT1J2EnvgLArwLwsho9UHsUTFP4
```

*Note: This supports the fork only. To support the upstream FreeTube project, visit [freetubeapp.io](https://freetubeapp.io/).*

## Credits

FreeTube + Tabs is built on top of [FreeTube](https://github.com/FreeTubeApp/FreeTube) by the FreeTube team. All credit for the core application goes to them.

See the full list of [People and Projects](https://docs.freetubeapp.io/credits/) that make FreeTube possible.

## License
[![GNU AGPLv3 Image](https://www.gnu.org/graphics/agplv3-155x51.png)](https://www.gnu.org/licenses/agpl-3.0.html)

FreeTube + Tabs is Free Software under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html), the same license as upstream FreeTube.
