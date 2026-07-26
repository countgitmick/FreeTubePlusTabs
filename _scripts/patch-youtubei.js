/**
 * Patches youtubei.js with fork-local behaviour changes.
 *
 * Most of what this script used to do is now upstream. As of youtubei.js
 * 17.2.0 the renamed-channel-filter-renderer patches (ItemSection ChipBarView,
 * Channel.filters / applyFilter / continuation memo), the LockupView entries in
 * Feed.getVideosFromMemo, and the WEB clientVersion bump are all shipped by
 * upstream — the last is newer there than the value we were pinning.
 *
 * A patch that no longer applies is ambiguous: it can mean "upstream fixed
 * this" or "upstream moved the code and we are now silently unpatched". The
 * previous version of this script only warned, so the two were
 * indistinguishable — which is exactly how a youtubei.js bump looked like a
 * breakage when it was really an upstream fix. Every patch now carries an
 * `assert` describing the behaviour it exists to guarantee:
 *
 *   find matches                  -> patch applied
 *   find missing, assert present  -> upstream does it now; report and move on
 *   find missing, assert missing  -> hard failure, we are silently unpatched
 *
 * Upstream: LuanRT/YouTube.js#1142, FreeTubeApp/FreeTube#8639
 */

const fs = require('fs')
const path = require('path')

const YTJS_ROOT = path.join(__dirname, '..', 'node_modules', 'youtubei.js', 'dist', 'src', 'parser')

let failed = false

/**
 * @param {string} relPath file to patch, relative to the parser directory
 * @param {{describes: string, marker: string, find: string, replace: string, assert: string}[]} replacements
 */
function patchFile(relPath, replacements) {
  const filePath = path.join(YTJS_ROOT, relPath)

  if (!fs.existsSync(filePath)) {
    console.error(`[patch-youtubei] ${relPath}: file not found — youtubei.js layout changed`)
    failed = true
    return
  }

  let content = fs.readFileSync(filePath, 'utf8')
  let patched = false

  for (const { describes, marker, find, replace, assert } of replacements) {
    // Already patched by a previous install — idempotent.
    if (content.includes(marker)) {
      continue
    }

    if (content.includes(find)) {
      content = content.replace(find, replace)
      patched = true
      continue
    }

    // The patch did not apply. Decide whether that is fine or fatal.
    if (assert && content.includes(assert)) {
      console.warn(`[patch-youtubei] ${relPath}: "${describes}" is handled upstream now — patch no longer needed`)
      continue
    }

    console.error(`[patch-youtubei] ${relPath}: "${describes}" did not apply and is NOT handled upstream`)
    failed = true
  }

  if (patched) {
    fs.writeFileSync(filePath, content, 'utf8')
    console.warn(`[patch-youtubei] Patched ${relPath}`)
  }
}

// --- LiveChat.js ---
// Route missing continuation_contents through the existing retry path instead of
// immediately stopping. The catch block already retries up to 10 times with 2s
// backoff. Without this, a transient empty response kills the chat daemon, and
// the missing return falls through to crash on contents.continuation.token.
//
// No upstream equivalent — upstream still ends the daemon rather than retrying —
// so there is no assert that could excuse this failing to apply.
patchFile('youtube/LiveChat.js', [{
  describes: 'retry on missing live chat continuation contents',
  marker: '// [FT-patch] route missing contents through retry',
  find: [
    '                if (!contents) {',
    "                    this.emit('error', new InnertubeError('Unexpected live chat incremental continuation response', response));",
    "                    this.emit('end');",
    '                    this.stop();',
    '                }',
  ].join('\n'),
  replace: [
    '                // [FT-patch] route missing contents through retry',
    '                if (!contents) {',
    "                    throw new InnertubeError('Unexpected live chat incremental continuation response', response);",
    '                }',
  ].join('\n'),
  assert: '',
}])

if (failed) {
  console.error('[patch-youtubei] One or more required patches did not apply. Refusing to continue.')
  process.exit(1)
}
