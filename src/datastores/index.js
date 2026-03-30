import Datastore from '@seald-io/nedb'

let dbPath = null

if (process.env.IS_ELECTRON_MAIN) {
  const { app } = require('electron')
  const { join } = require('path')
  // this code only runs in the electron main process, so hopefully using sync fs code here should be fine 😬
  const { statSync, realpathSync, renameSync, mkdirSync, existsSync } = require('fs')

  // Set a stable userData path that doesn't depend on how Electron resolves app.name.
  // Without this, the path shifts when the launch method changes (e.g. from
  // "electron dist/main.js" -> "electron /app-dir/"), breaking profile continuity.
  const canonicalUserData = join(app.getPath('appData'), 'freetube-plus-tabs')

  if (!existsSync(canonicalUserData)) {
    mkdirSync(canonicalUserData, { recursive: true })
  }

  // One-time migration from ~/.config/Electron/ (legacy Nix wrapper default)
  const DB_FILES = [
    'settings.db', 'profiles.db', 'playlists.db',
    'history.db', 'search-history.db', 'subscription-cache.db', 'tabs.db'
  ]

  const hasCanonicalData = DB_FILES.some(f => {
    try { return statSync(join(canonicalUserData, f), { throwIfNoEntry: false })?.size > 0 } catch { return false }
  })

  if (!hasCanonicalData) {
    const legacyDir = join(app.getPath('appData'), 'Electron')
    const hasLegacyData = existsSync(legacyDir) && DB_FILES.some(f => {
      try { return statSync(join(legacyDir, f), { throwIfNoEntry: false })?.size > 0 } catch { return false }
    })

    if (hasLegacyData) {
      for (const f of DB_FILES) {
        const src = join(legacyDir, f)
        if (existsSync(src)) {
          renameSync(src, join(canonicalUserData, f))
        }
      }
    }
  }

  app.setPath('userData', canonicalUserData)

  const userDataPath = app.getPath('userData')
  dbPath = (dbName) => {
    let path = join(userDataPath, `${dbName}.db`)

    // returns undefined if the path doesn't exist
    if (statSync(path, { throwIfNoEntry: false })?.isSymbolicLink) {
      path = realpathSync(path)
    }

    return path
  }
} else {
  dbPath = (dbName) => `${dbName}.db`
}

/**
 * @param {string} name
 */
function createDatastore(name) {
  return new Datastore({
    filename: dbPath(name),
    autoload: !process.env.IS_ELECTRON_MAIN,
    // Automatically clean up corrupted data, instead of crashing
    corruptAlertThreshold: 1
  })
}

export const settings = createDatastore('settings')
export const profiles = createDatastore('profiles')
export const playlists = createDatastore('playlists')
export const history = createDatastore('history')
export const searchHistory = createDatastore('search-history')
export const subscriptionCache = createDatastore('subscription-cache')
export const tabs = createDatastore('tabs')
