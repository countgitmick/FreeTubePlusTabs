<template>
  <div>
    <FtLoader v-if="isLoading" />
    <template
      v-else
    >
      <FtCard>
        <FtCommunityPost
          :data="post"
          :single-post="true"
          appearance="result"
        />
      </FtCard>
      <CommentSection
        :id="post.postId"
        :channel-name="post.author"
        :post-author-id="authorId"
        :video-player-ready="false"
        :force-state="null"
        :is-post-comments="true"
        :channel-thumbnail="post.authorThumbnails[0].url"
        :show-sort-by="backendPreference == 'local'"
      />
    </template>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import packageDetails from '../../../package.json'

import FtCard from '../components/ft-card/ft-card.vue'
import FtCommunityPost from '../components/FtCommunityPost/FtCommunityPost.vue'
import FtLoader from '../components/FtLoader/FtLoader.vue'
import CommentSection from '../components/CommentSection/CommentSection.vue'

import store from '../store/index'

import { getInvidiousCommunityPost } from '../helpers/api/invidious'
import { getLocalCommunityPost } from '../helpers/api/local'
import { useBackendFetch } from '../composables/use-backend-fetch'

const { backendFetch } = useBackendFetch()

const router = useRouter()
const route = useRoute()
const isTabActive = inject('isTabActive', ref(true))

const id = ref('')
const authorId = ref('')
const post = shallowRef(null)
const isLoading = ref(true)

/** @type {import('vue').ComputedRef<'invidious' | 'local'>} */
const backendPreference = computed(() => {
  return store.getters.getBackendPreference
})

onMounted(async () => {
  id.value = route.params.id
  authorId.value = route.query.authorId
  await loadData()
})

function updateTitleAndRoute() {
  store.commit('setAppTitle', `${post.value.author} - ${packageDetails.productName}`)
  isLoading.value = false

  // If the authorId is missing from the URL we should add it,
  // that way if the user comes back to this page by pressing the back button
  // we don't have to resolve the authorId again
  if (authorId.value !== route.query.authorId) {
    router.replace({
      path: `/post/${id.value}`,
      query: {
        authorId: authorId.value
      }
    })
  }
}

async function loadData() {
  try {
    const result = await backendFetch(
      () => getLocalCommunityPost(id.value, authorId.value),
      () => getInvidiousCommunityPost(id.value, authorId.value),
    )
    post.value = result
    authorId.value = result.authorId
    updateTitleAndRoute()
  } catch {
    isLoading.value = false
  }
}

watch(() => route.params.id, async () => {
  if (store.getters['tabs/getTabSwitchNavCount'] > 0) return
  if (!isTabActive.value) return
  // react to route changes...
  isLoading.value = true
  id.value = route.params.id
  authorId.value = route.query.authorId
  await loadData()
})
</script>
