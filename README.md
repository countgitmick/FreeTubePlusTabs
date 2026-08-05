<p align="center">
 <img alt="FreeTube + Tabs" src="/_icons/icon.svg" width=64 align="center">
</p>

<h1 align="center">FreeTube + Tabs</h1>

<h4 align="center">Ad-Free YouTube Client with Tabbed Browsing</h4>

<hr>

## What It Is

FreeTube + Tabs is a desktop YouTube client with browser-style tabs. It plays no
ads, runs no tracking script, and needs no Google account.

The program started from [FreeTube](https://github.com/FreeTubeApp/FreeTube) and
carries the same GNU AGPL-3.0 license.

<p align="center">
 <img alt="FreeTube + Tabs showing multiple open tabs" src="/_icons/preview.png" width=800>
</p>

## Features

- A tab holds a video, a channel, a search, or a playlist. Middle-click or Ctrl+click opens one.
- Each tab keeps its own scroll position, video timestamp, and back history.
- One tab plays audio at a time. The others pause.
- Tabs drag to reorder. The right-click menu holds Close, Close Others, Close to Right, and Duplicate.
- Shortcuts: `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, and `Ctrl+1` to `Ctrl+9`.
- Open tabs return at the next start. The default limit is 20 tabs.
- Two API backends: the local API through youtubei.js, and Invidious.
- SponsorBlock and DeArrow.
- Linux hardware video decode through VA-API, and system media key control.

## Install

Builds for Windows, Mac, and Linux are on the [releases page](../../releases).

### Flatpak

Download the `.flatpak` bundle from the [latest release](../../releases/latest).
Then run:

```bash
flatpak install --user freetube-plus-tabs-*-linux-x86_64.flatpak
flatpak run io.github.countgitmick.FreeTubePlusTabs
```

To update, install the new bundle over the old one. To remove the program, run
`flatpak uninstall --user io.github.countgitmick.FreeTubePlusTabs`.

### NixOS

```bash
nix run github:countgitmick/FreeTubePlusTabs
```

To install it, add the flake to your inputs:

```nix
inputs.freetube-plus-tabs.url = "github:countgitmick/FreeTubePlusTabs";

environment.systemPackages = [ inputs.freetube-plus-tabs.packages.${pkgs.system}.default ];
```

## Coming From FreeTube

Subscriptions, playlists, history, and settings carry over. Both programs use the
same data directory.

Remove FreeTube before you install this program. Do not run both.

To go back, remove this program and install FreeTube. The data stays intact.

## What This Project Maintains

This project owns four subsystems and repairs them here.

**Tabs.** The tab layer runs inside the Vue renderer as a single-page feature. It
adds no dependency and uses no Electron tab API. State lives in
`src/renderer/store/modules/tabs.js`. The interface lives in
`src/renderer/components/FtTabBar/` and `src/renderer/components/TabContent/`.
[DESIGN-TABS.md](DESIGN-TABS.md) holds the design.

**Player.** The SABR streaming path, the Shaka 5 integration, and PO token
generation. See `src/renderer/helpers/player/SabrSchemePlugin.js` and
`src/renderer/components/ft-shaka-video-player/`.

**Subscriptions.** A coordinator paces and limits every channel fetch. It picks
between channel RSS, yt-dlp, and a scraper. See
`src/renderer/store/modules/subscription-refresh-coordinator.js` and
`src/renderer/helpers/subscriptions-fetcher.js`.

**Packaging.** The Flatpak bundle, the Nix flake, VA-API decode on Linux, and
system media controls.

Eight releases shipped between 2026-04-19 and 2026-07-31. The
[releases page](../../releases) holds the full history.

This project keeps its own code. It does not track upstream FreeTube release for
release. If an upstream change applies and does not conflict with the four
subsystems in this section, this project adopts it. Report every problem to
[this issue tracker](../../issues), not to upstream FreeTube.

## Privacy

The program runs no YouTube tracking script. It stores no cookie. It needs no
Google account. It sends no telemetry and no analytics.

The program does connect directly to the YouTube servers at `googlevideo.com`,
`youtube.com`, and `ytimg.com`. Those servers receive your IP address and the
list of what you watch. Invidious, NewPipe, and yt-dlp work the same way. For
privacy at the IP level, use a VPN or Tor.

## Security

- `contextIsolation` is on. `nodeIntegration` is off. The code sets both explicitly.
- The renderer reaches the main process only through a context-bridged preload with an action allowlist.
- Permission handlers check the origin of the request and the full frame chain.
- Every renderer HTML file carries a Content Security Policy.

Known trade-off: `webSecurity` is off, because the renderer sends direct
cross-origin requests to the YouTube CDNs. This comes from upstream FreeTube. A
fix needs every media request to pass through a custom protocol handler. That
work is not done.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) holds the build steps, the code standards, and
the rules for the tab system.

## Support

Monero (XMR):

```
473aJKYE7YRX2eWQfPqhaEh6EV9ZrQxyWUWEEyy6KrnraSPEQXAzwNaHBN7EsqVLMFUocT1J2EnvgLArwLwsho9UHsUTFP4
```

This address supports this project only. To support upstream FreeTube, visit
[freetubeapp.io](https://freetubeapp.io/).

## Credits

This program started from [FreeTube](https://github.com/FreeTubeApp/FreeTube).
The FreeTube team wrote the core application. The
[credits page](https://docs.freetubeapp.io/credits/) lists the people and
projects behind it.

## License

[![GNU AGPLv3 Image](https://www.gnu.org/graphics/agplv3-155x51.png)](https://www.gnu.org/licenses/agpl-3.0.html)

FreeTube + Tabs is Free Software under the
[GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html).
