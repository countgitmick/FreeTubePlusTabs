import { contextBridge, ipcRenderer, webFrame } from 'electron/renderer'
import { IpcChannels } from '../constants.js'
import api from './interface.js'

contextBridge.exposeInMainWorld('ftElectron', api)

// On Linux, override the HTML5 Fullscreen API to route through Electron's
// native BrowserWindow.setFullScreen(), which uses the proper xdg_toplevel
// Wayland protocol. Chromium's HTML fullscreen path causes the compositor
// to briefly unmap the window surface during the fullscreen→windowed
// transition; the native path avoids this entirely.
//
// The override is transparent to all consumers (Shaka UI button, keyboard
// shortcuts, etc.) — they continue calling the standard DOM API, which
// we intercept and redirect through IPC to the main process.
if (process.platform === 'linux') {
  webFrame.executeJavaScript(`(function() {
    var fullscreenEl = null
    var pendingEl = null

    Element.prototype.requestFullscreen = function() {
      pendingEl = this
      document.dispatchEvent(new CustomEvent('__ft-fs', { detail: 'enter' }))
      return Promise.resolve()
    }

    Document.prototype.exitFullscreen = function() {
      document.dispatchEvent(new CustomEvent('__ft-fs', { detail: 'exit' }))
      return Promise.resolve()
    }

    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      get: function() { return fullscreenEl },
      configurable: true
    })

    document.addEventListener('__ft-fs-changed', function(e) {
      fullscreenEl = e.detail === 'enter'
        ? (pendingEl || document.documentElement)
        : null
      pendingEl = null
      document.dispatchEvent(new Event('fullscreenchange'))
    })
  })()`)

  // Bridge: main world custom events ↔ main process IPC
  document.addEventListener('__ft-fs', (e) => {
    ipcRenderer.send(IpcChannels.SET_FULLSCREEN, e.detail === 'enter')
  })

  ipcRenderer.on(IpcChannels.FULLSCREEN_CHANGED, (_, isFullscreen) => {
    document.dispatchEvent(new CustomEvent('__ft-fs-changed', {
      detail: isFullscreen ? 'enter' : 'exit'
    }))
  })
}
