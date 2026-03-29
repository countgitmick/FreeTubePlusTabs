/**
 * Patches youtubei.js to support YouTube's renamed channel filter renderers.
 *
 * YouTube renamed:
 *   feedFilterChipBarRenderer → chipBarViewRenderer
 *   chipCloudChipRenderer     → chipViewRenderer
 *
 * The youtubei.js parser has classes for both (ChipBarView, ChipView) but
 * ItemSection rejects ChipBarView in its type check, and Channel.filters
 * only looks for FeedFilterChipBar. This patch adds the fallback chain.
 *
 * Upstream: LuanRT/YouTube.js#1142, FreeTubeApp/FreeTube#8639
 */

/* eslint-disable @stylistic/quotes, no-template-curly-in-string */

const fs = require('fs')
const path = require('path')

const YTJS_ROOT = path.join(__dirname, '..', 'node_modules', 'youtubei.js', 'dist', 'src', 'parser')

function patchFile(relPath, replacements) {
  const filePath = path.join(YTJS_ROOT, relPath)

  if (!fs.existsSync(filePath)) {
    console.warn(`[patch-youtubei] Skipping ${relPath}: file not found`)
    return
  }

  let content = fs.readFileSync(filePath, 'utf8')
  let patched = false

  for (const { marker, find, replace } of replacements) {
    // Skip if already patched (idempotent)
    if (content.includes(marker)) {
      continue
    }
    if (!content.includes(find)) {
      console.warn(`[patch-youtubei] ${relPath}: expected string not found, skipping replacement`)
      continue
    }
    content = content.replace(find, replace)
    patched = true
  }

  if (patched) {
    fs.writeFileSync(filePath, content, 'utf8')
    console.warn(`[patch-youtubei] Patched ${relPath}`)
  }
}

// --- Patch 1: ItemSection.js ---
// Add ChipBarView to valid header types so the parser accepts it into the memo
patchFile('classes/ItemSection.js', [{
  marker: "import ChipBarView from './ChipBarView.js';",
  find: "import FeedFilterChipBar from './FeedFilterChipBar.js';",
  replace: [
    "import FeedFilterChipBar from './FeedFilterChipBar.js';",
    "import ChipBarView from './ChipBarView.js';"
  ].join('\n'),
}, {
  marker: 'SortFilterHeader, FeedFilterChipBar, ChipBarView])',
  find: 'SortFilterHeader, FeedFilterChipBar])',
  replace: 'SortFilterHeader, FeedFilterChipBar, ChipBarView])',
}])

// --- Patch 2: Channel.js ---
// Add ChipBarView/ChipView imports, unified filters getter, unified applyFilter,
// and preserve modern chips in FilteredChannelList continuations
patchFile('youtube/Channel.js', [
  // 2a: Add imports
  {
    marker: "import ChipBarView from '../classes/ChipBarView.js';",
    find: "import FeedFilterChipBar from '../classes/FeedFilterChipBar.js';",
    replace: [
      "import FeedFilterChipBar from '../classes/FeedFilterChipBar.js';",
      "import ChipBarView from '../classes/ChipBarView.js';",
      "import ChipView from '../classes/ChipView.js';"
    ].join('\n'),
  },
  // 2b: Unified filters getter — fall back to ChipBarView when FeedFilterChipBar absent
  {
    marker: 'chipBarView.chips.filterType(ChipView)',
    find: [
      '    get filters() {',
      "        return this.memo.getType(FeedFilterChipBar)?.[0]?.contents.filterType(ChipCloudChip).map((chip) => chip.text) || [];",
      '    }'
    ].join('\n'),
    replace: [
      '    get filters() {',
      '        const feedFilterChipBar = this.memo.getType(FeedFilterChipBar)?.[0];',
      '        if (feedFilterChipBar) {',
      '            return feedFilterChipBar.contents.filterType(ChipCloudChip).map((chip) => chip.text);',
      '        }',
      '        const chipBarView = this.memo.getType(ChipBarView)?.[0];',
      '        if (chipBarView) {',
      '            return chipBarView.chips.filterType(ChipView).map((chip) => chip.text);',
      '        }',
      '        return [];',
      '    }'
    ].join('\n'),
  },
  // 2c: Unified applyFilter — search both chip containers
  {
    marker: '// Fallback: try modern ChipBarView',
    find: [
      '    async applyFilter(filter) {',
      '        let target_filter;',
      '        const filter_chipbar = this.memo.getType(FeedFilterChipBar)[0];',
      '        if (typeof filter === \'string\') {',
      '            target_filter = filter_chipbar?.contents.find((chip) => chip.text === filter);',
      '            if (!target_filter)',
      '                throw new InnertubeError(`Filter ${filter} not found`, { available_filters: this.filters });',
      '        }',
      '        else {',
      '            target_filter = filter;',
      '        }',
    ].join('\n'),
    replace: [
      '    async applyFilter(filter) {',
      '        let target_filter;',
      '        // Try legacy FeedFilterChipBar',
      '        const filter_chipbar = this.memo.getType(FeedFilterChipBar)?.[0];',
      '        if (filter_chipbar) {',
      '            if (typeof filter === \'string\') {',
      '                target_filter = filter_chipbar.contents.find((chip) => chip.text === filter);',
      '            }',
      '            else {',
      '                target_filter = filter;',
      '            }',
      '        }',
      '        // Fallback: try modern ChipBarView (YouTube renamed the renderers)',
      '        if (!target_filter) {',
      '            const chipBarView = this.memo.getType(ChipBarView)?.[0];',
      '            if (chipBarView) {',
      '                if (typeof filter === \'string\') {',
      '                    target_filter = chipBarView.chips.find((chip) => chip.text === filter);',
      '                }',
      '                else {',
      '                    target_filter = filter;',
      '                }',
      '            }',
      '        }',
      '        if (!target_filter)',
      '            throw new InnertubeError(`Filter ${filter} not found`, { available_filters: this.filters });',
    ].join('\n'),
  },
  // 2d: Preserve modern chips in FilteredChannelList continuations
  {
    marker: "// Preserve modern filter chips",
    find: [
      "        // Keep the filters",
      "        page.on_response_received_actions_memo.set('FeedFilterChipBar', this.memo.getType(FeedFilterChipBar));",
      "        page.on_response_received_actions_memo.set('ChipCloudChip', this.memo.getType(ChipCloudChip));"
    ].join('\n'),
    replace: [
      "        // Preserve legacy filter chips",
      "        page.on_response_received_actions_memo.set('FeedFilterChipBar', this.memo.getType(FeedFilterChipBar));",
      "        page.on_response_received_actions_memo.set('ChipCloudChip', this.memo.getType(ChipCloudChip));",
      "        // Preserve modern filter chips (YouTube renamed the renderers)",
      "        page.on_response_received_actions_memo.set('ChipBarView', this.memo.getType(ChipBarView));",
      "        page.on_response_received_actions_memo.set('ChipView', this.memo.getType(ChipView));"
    ].join('\n'),
  },
])

// --- Patch 3: LiveChat.js ---
// Route missing continuation_contents through the existing retry path instead of
// immediately stopping. The catch block already retries up to 10 times with 2s backoff.
// Without this patch, a transient empty response kills the chat daemon and the missing
// return falls through to crash on contents.continuation.token.
patchFile('youtube/LiveChat.js', [{
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
}])
