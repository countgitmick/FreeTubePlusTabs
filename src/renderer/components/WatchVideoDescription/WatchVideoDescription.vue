<template>
  <FtCard
    v-if="shownDescription.length > 0"
    :class="{ videoDescription: true, short: !showFullDescription }"
  >
    <span
      v-if="showControls && !showFullDescription"
      class="descriptionStatus"
      role="button"
      tabindex="0"
      @click="expandDescription"
      @keydown.space.prevent="expandDescription"
      @keydown.enter.prevent="expandDescription"
    >
      {{ $t("Description.Expand Description") }}
    </span>
    <FtTimestampCatcher
      ref="descriptionContainer"
      class="description"
      :input-html="processedShownDescription"
      :link-tab-index="linkTabIndex"
      @timestamp-event="onTimestamp"
      @click="expandDescriptionWithClick"
    />
    <bdi
      v-if="license && showFullDescription"
      class="license"
    >
      {{ license }}
    </bdi>
    <span
      v-if="showControls && showFullDescription"
      class="descriptionStatus"
      role="button"
      tabindex="0"
      @click="collapseDescription"
      @keydown.space.prevent="collapseDescription"
      @keydown.enter.prevent="collapseDescription"
    >
      {{ $t("Description.Collapse Description") }}
    </span>
  </FtCard>
</template>

<script setup>
import autolinker from 'autolinker'
import DOMPurify from 'dompurify'

import { onMounted, ref, computed, useTemplateRef } from 'vue'
import FtCard from '../ft-card/ft-card.vue'
import FtTimestampCatcher from '../FtTimestampCatcher.vue'

const props = defineProps({
  description: {
    type: String,
    default: ''
  },
  descriptionHtml: {
    type: String,
    default: ''
  },
  license: {
    type: String,
    default: null,
  }
})

const emit = defineEmits(['timestamp-event'])

let shownDescription = ''
const descriptionContainer = useTemplateRef('descriptionContainer')
const showFullDescription = ref(false)
const showControls = ref(false)

if (props.descriptionHtml !== '') {
  const parsed = parseDescriptionHtml(props.descriptionHtml)

  // the invidious API returns emtpy html elements when the description is empty
  // so we need to parse it to see if there is any meaningful text in the html
  // or if it's just empty html elements e.g. `<p></p>`

  const testDiv = document.createElement('div')
  testDiv.innerHTML = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: ['br', 'b', 'i', 's', 'a', 'p'],
    ALLOWED_ATTR: ['href', 'data-time', 'dir', 'lang']
  })

  if (!/^\s*$/.test(testDiv.innerText)) {
    shownDescription = parsed
  }
} else {
  if (!/^\s*$/.test(props.description)) {
    shownDescription = autolinker.link(props.description)
  }
}

const processedShownDescription = computed(() => {
  if (shownDescription === '') { return shownDescription }

  return processDescriptionHtml(shownDescription, linkTabIndex.value)
})

const linkTabIndex = computed(() => {
  return showFullDescription.value ? '0' : '-1'
})

/**
 * @param {number} timestamp
 */
function onTimestamp(timestamp) {
  emit('timestamp-event', timestamp)
}

/**
 @param {PointerEvent} e
 */
function expandDescriptionWithClick(e) {
  // Ignore link clicks
  if (e.target.tagName === 'A') { return }

  expandDescription()
}

/**
 * Enables user to view entire contents of description
 */
function expandDescription() {
  showFullDescription.value = true
}

/**
 * Enables user to collapse contents of description
 */
function collapseDescription() {
  showFullDescription.value = false
}

/**
 * Returns true when description content does not overflow description container
 * Useful for hiding description expansion/contraction controls
 */
function isShortDescription() {
  const descriptionElem = descriptionContainer.value?.$el
  return descriptionElem?.clientHeight >= descriptionElem?.scrollHeight
}

onMounted(() => {
  // To verify whether or not the description is too short for displaying
  // description controls, we need to check the description's dimensions.
  // The only way to make this work is to check on mount.
  showFullDescription.value = isShortDescription()
  showControls.value = !showFullDescription.value
})

/**
 * @param {string} descriptionText
 * @returns {string}
 */
function parseDescriptionHtml(descriptionText) {
  // Sanitize first to strip scripts, event handlers, and dangerous attributes.
  // This replaces the previous regex-based stripping which could miss edge cases
  // (e.g. single-quoted attrs, event handlers like onclick/onerror).
  const clean = DOMPurify.sanitize(descriptionText, {
    ALLOWED_TAGS: ['br', 'b', 'i', 's', 'a', 'p'],
    ALLOWED_ATTR: ['href', 'data-time', 'dir', 'lang']
  })

  // Rewrite YouTube redirect URLs and relative paths on the sanitized output
  return clean
    .replaceAll(/\/redirect.+?(?=q=)/g, '')
    .replaceAll('q=', '')
    .replaceAll('&amp;', '&')
    .replaceAll('%3A', ':')
    .replaceAll('%2F', '/')
    .replaceAll(/&v.+?(?=")/g, '')
    .replaceAll(/&redirect-token.+?(?=")/g, '')
    .replaceAll(/&redir_token.+?(?=")/g, '')
    .replaceAll('href="/', 'href="https://www.youtube.com/')
    .replaceAll('href="/hashtag/', 'href="https://www.youtube.com/hashtag/')
    .replaceAll('yt.www.watch.player.seekTo', 'changeDuration')
}

/**
 * @param {string} descriptionText
 * @param {string} tabIndex
 * @returns {string}
 */
function processDescriptionHtml(descriptionText, tabIndex) {
  return descriptionText
    .replaceAll('<a', `<a tabindex="${tabIndex}"`)
}
</script>

<style scoped src="./WatchVideoDescription.css" />
