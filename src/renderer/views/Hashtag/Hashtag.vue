<template>
  <div>
    <FtLoader
      v-if="isLoading"
      :fullscreen="true"
    />
    <FtCard
      v-else
      class="card"
    >
      <h2>
        <font-awesome-icon
          :icon="['fas', 'hashtag']"
          aria-hidden="false"
          class="headingIcon"
        />
        <bdi>{{ hashtag }}</bdi>
      </h2>
      <FtElementList
        v-if="videos.length > 0"
        :data="videos"
      />
      <FtFlexBox
        v-else
      >
        <p
          class="message"
        >
          {{ $t("Hashtag.This hashtag does not currently have any videos") }}
        </p>
      </FtFlexBox>

      <FtAutoLoadNextPageWrapper
        v-if="showFetchMoreButton"
        @load-next-page="handleFetchMore"
      >
        <div
          class="getNextPage"
          role="button"
          tabindex="0"
          @click="handleFetchMore"
          @keydown.space.prevent="handleFetchMore"
          @keydown.enter.prevent="handleFetchMore"
        >
          <FontAwesomeIcon :icon="['fas', 'search']" /> {{ $t("Search Filters.Fetch more results") }}
        </div>
      </FtAutoLoadNextPageWrapper>
    </FtCard>
  </div>
</template>
<script setup>
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import store from '../../store/index'
import { useRoute } from 'vue-router'
import packageDetails from '../../../../package.json'
import { getHashtagLocal, parseLocalListVideo } from '../../helpers/api/local'
import { isNullOrEmpty } from '../../helpers/strings'
import { getHashtagInvidious } from '../../helpers/api/invidious'
import { useBackendFetch } from '../../composables/use-backend-fetch'
import { useTabRouteGuard } from '../../composables/use-tab-route-guard'

const { backendFetch } = useBackendFetch()

const route = useRoute()
const isTabActive = inject('isTabActive', ref(true))
const { shouldSkipRouteChange } = useTabRouteGuard(isTabActive)

const hashtag = ref('')
const hashtagContinuationData = shallowRef(null)
const videos = shallowRef([])
/** @type {import('vue').Ref<'local' | 'invidious'>} */
const apiUsed = ref('local')
const pageNumber = ref(1)
const isLoading = ref(true)

const showFetchMoreButton = computed(() => {
  return !isNullOrEmpty(hashtagContinuationData.value) || apiUsed.value === 'invidious'
})

onMounted(() => {
  getHashtag()
})

watch(() => route.params.hashtag, () => {
  if (shouldSkipRouteChange()) return
  resetData()
  getHashtag()
})

function resetData() {
  isLoading.value = true
  hashtag.value = ''
  hashtagContinuationData.value = null
  videos.value = []
  apiUsed.value = 'local'
  pageNumber.value = 1
}

async function getHashtag() {
  hashtag.value = decodeURIComponent(route.params.hashtag)
  try {
    await backendFetch(
      async () => {
        const hashtagData = await getHashtagLocal(hashtag.value)
        videos.value = hashtagData.videos.map((video) => parseLocalListVideo(video))
        apiUsed.value = 'local'
        hashtagContinuationData.value = hashtagData.has_continuation ? hashtagData : null
        isLoading.value = false
      },
      async () => {
        const fetchedVideos = await getHashtagInvidious(hashtag.value)
        isLoading.value = false
        apiUsed.value = 'invidious'
        videos.value = videos.value.concat(fetchedVideos)
        pageNumber.value += 1
      },
    )
  } catch {
    isLoading.value = false
  }
  store.commit('setAppTitle', `#${hashtag.value} - ${packageDetails.productName}`)
}

/**
 * Fetch the next page of results from Invidious.
 * @param {number} page
 */
async function getInvidiousHashtagPage(page) {
  const fetchedVideos = await getHashtagInvidious(hashtag.value, page)
  isLoading.value = false
  apiUsed.value = 'invidious'
  videos.value = videos.value.concat(fetchedVideos)
  pageNumber.value += 1
}

async function getLocalHashtagMore() {
  try {
    await backendFetch(
      async () => {
        const continuation = await hashtagContinuationData.value.getContinuation()
        const newVideos = continuation.videos.map((video) => parseLocalListVideo(video))
        hashtagContinuationData.value = continuation.has_continuation ? continuation : null
        videos.value = videos.value.concat(newVideos)
      },
      async () => {
        resetData()
        const fetchedVideos = await getHashtagInvidious(hashtag.value)
        isLoading.value = false
        apiUsed.value = 'invidious'
        videos.value = videos.value.concat(fetchedVideos)
        pageNumber.value += 1
      },
    )
  } catch {
    isLoading.value = false
  }
}

function handleFetchMore() {
  if (process.env.SUPPORTS_LOCAL_API && apiUsed.value === 'local') {
    getLocalHashtagMore()
  } else if (apiUsed.value === 'invidious') {
    getInvidiousHashtagPage(pageNumber.value)
  }
}
</script>
<style scoped src="./Hashtag.css" />
