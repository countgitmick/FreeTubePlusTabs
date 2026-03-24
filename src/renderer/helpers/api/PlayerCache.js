const IPC_TIMEOUT = 10_000

function withTimeout(promise) {
  let timeoutId
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`IPC call timed out after ${IPC_TIMEOUT}ms`))
    }, IPC_TIMEOUT)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

export class PlayerCache {
  async get(key) {
    return await withTimeout(window.ftElectron.playerCacheGet(key))
  }

  async set(key, value) {
    await withTimeout(window.ftElectron.playerCacheSet(key, value))
  }

  async remove(_key) {
    // no-op; YouTube.js only uses remove for the OAuth credentials, but we don't use that in FreeTube
  }
}
