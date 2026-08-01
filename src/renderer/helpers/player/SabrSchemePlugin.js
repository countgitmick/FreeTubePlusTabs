import { base64ToU8, concatenateChunks, EventEmitterLike, MAX_INT32_VALUE } from 'googlevideo/utils'
import { CompositeBuffer, UmpReader } from 'googlevideo/ump'
import {
  UMPPartId,
  VideoPlaybackAbrRequest,
  StreamProtectionStatus,
  SabrError,
  SabrRedirect,
  MediaHeader,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrContextWritePolicy,
  NextRequestPolicy,
  ReloadPlaybackContext,
} from 'googlevideo/protos'
import shaka from 'shaka-player'

import { deepCopy } from '../utils'

const AbortableOperation = shaka.util.AbortableOperation
const ShakaError = shaka.util.Error

/** @type {Map<string, Function>} */
const sabrHandlers = new Map()
let schemeRegistered = false

/**
 * @typedef OperationInputs
 * @type {object}
 * @property {string} uri
 * @property {shaka.extern.Request} request
 * @property {shaka.net.NetworkingEngine.RequestType} requestType
 * @property {shaka.extern.HeadersReceived} headersReceived
 * The following are calculated from above properties
 * @property {string} formatIdString
 * @property {boolean} isInit
 * @property {number} sequenceNumber
 */
/**
 * @typedef AbortStatus
 * @type {object}
 * @property {boolean} cancelled
 * @property {boolean} timedOut
 * @property {boolean} playerReloadRequested
 * @property {boolean} finished
 */
/**
 * @typedef CurrentState
 * @type {object}
 * @property {Map<string, Uint8Array>} initDataCache
 * @property {VideoPlaybackAbrRequest} abrRequest
 * @property {RequestInit} requestInit
 * @property {AbortStatus} abortStatus
 * @property {AbortController} abortController
 * @property {SabrStreamState} sabrStreamState
 * @property {?TimeoutController} timeoutController
 * @property {?EventEmitterLike} eventEmitter
 * @property {number} cumulativeBackOffTimeMs
 * @property {number} cumulativeBackOffRequested
 * @property {number} cumulativeRetryDueToNextRequestPolicy
 */
/**
 * @typedef SabrStreamState
 * @type {object}
 * @property {string} sabrUrl
 * @property {Set<number>} activeSabrContextTypes
 * @property {Map<number, SabrContextUpdate>} sabrContexts
 * @property {?NextRequestPolicy} nextRequestPolicy
 * @property {Uint8Array | undefined} playbackCookieBytes the playbackCookie
 *   exactly as YouTube sent it. Re-encoding a decoded cookie loses bytes and
 *   invalidates the session, see extractRawField.
 * @property {boolean} playerReloadRequested
 * @property {number} requestNumber
 * @property {number | undefined} lastRequestAtMs when the previous request to
 *   this stream went out, so a 401 can be reported against the server's own
 *   maxTimeSinceLastRequestMs
 */
/**
 * @typedef TimeoutController
 * @type {object}
 * @property {() => void} resetTimeoutOnce
 * @property {() => void} clearTimeout
 */
/**
 * @typedef SabrStream
 * @type {object}
 * @property {(cb: ({backoffMs: number}) => void) => void} onBackoffRequested
 * @property {(cb: () => void) => void} onReloadOnce
 * @property {() => void | undefined} cleanup
 */

/**
 * A response for a request that is deliberately abandoned.
 *
 * Shaka runs `response.timeMs += Date.now() - start` on every operation that
 * resolves, so resolving with nothing throws
 * "Cannot read properties of null (reading 'timeMs')" from inside shaka itself,
 * reported against a player that is already being torn down. The call sites
 * below resolve rather than reject on purpose, to stay quiet during teardown, so
 * they have to hand back something shaped the way shaka expects.
 *
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @returns {shaka.extern.Response}
 */
function createAbandonedResponse(uri, request) {
  return {
    uri,
    originalUri: uri,
    data: new ArrayBuffer(0),
    headers: {},
    status: 200,
    fromCache: false,
    originalRequest: request,
    timeMs: 0,
  }
}

/** NextRequestPolicy.playbackCookie, field 7 (tag 58 in the generated encoder). */
const PLAYBACK_COOKIE_FIELD_NUMBER = 7

/**
 * Lifts a length-delimited field out of a protobuf message without decoding it.
 *
 * The playbackCookie is an opaque session token, and it is the only thing that
 * tells YouTube where in the stream this session is. Decoding it and re-encoding
 * it is lossy: the generated encoder omits every field whose value equals the
 * protobuf default, so a cookie carrying an explicit zero comes back shorter
 * than it arrived. Measured against a live stream, YouTube sent 16 bytes and the
 * re-encode produced 14, dropping `field2 = 0`.
 *
 * A cookie YouTube cannot read is a session it cannot place. It then answers
 * every mid-stream request with a policy-only response carrying no MEDIA_HEADER
 * and no media, which is reproducible on demand: a request for any nonzero
 * playerTimeMs without valid session state returns 74 bytes. No segment ever
 * completes, the retry path runs to its cap of 100, and YouTube answers that
 * flood with 401. That is the "session expired" failure on long videos.
 *
 * googlevideo's generator does not preserve unknown fields, so round-tripping
 * through the generated type cannot be made lossless. yt-dlp avoids this by
 * treating the cookie as opaque bytes, which is what this does.
 *
 * @param {Uint8Array} bytes a protobuf message
 * @param {number} fieldNumber the length-delimited field to return verbatim
 * @returns {Uint8Array | undefined} the field's bytes, or undefined if absent
 */
function extractRawField(bytes, fieldNumber) {
  let offset = 0

  // Returns undefined on a truncated varint rather than a wrong number.
  function readVarint() {
    let result = 0
    let shift = 0
    while (offset < bytes.length) {
      const byte = bytes[offset++]
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) {
        return result
      }
      shift += 7
    }
    return undefined
  }

  while (offset < bytes.length) {
    const key = readVarint()
    if (key === undefined) return undefined

    // Plain arithmetic, not bit shifts: a large field number overflows 32 bits.
    const wireType = key % 8
    const field = Math.floor(key / 8)

    if (wireType === 2) {
      const length = readVarint()
      if (length === undefined || offset + length > bytes.length) return undefined
      if (field === fieldNumber) {
        return bytes.subarray(offset, offset + length)
      }
      offset += length
    } else if (wireType === 0) {
      if (readVarint() === undefined) return undefined
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 1) {
      offset += 8
    } else {
      // Deprecated groups. Skipping is not safe, so stop rather than guess.
      return undefined
    }
  }

  return undefined
}

/**
 * @param {string} str
 */
function formatIdFromString(str) {
  // buildFormatId joins with '-', but xtags contain '-' themselves: YouTube
  // sends values like `acont=dubbed-auto:lang=ar` on videos with dubbed or
  // multi-language audio. Splitting on every '-' truncated xtags to
  // `acont=dubbed`, so the MEDIA_HEADER format comparison never matched, no
  // media was collected, no segment completed, and the NEXT_REQUEST_POLICY
  // retry path looped until it hit its cap of 100. YouTube answers 401 to that
  // flood, which is what surfaced as "session expired" on those videos.
  //
  // Only the first two separators are structural. itag and lastModified cannot
  // contain '-', so everything after the second one is xtags.
  const firstSeparator = str.indexOf('-')
  const secondSeparator = str.indexOf('-', firstSeparator + 1)

  return {
    itag: parseInt(str.slice(0, firstSeparator)),
    lastModified: str.slice(firstSeparator + 1, secondSeparator),
    xtags: str.slice(secondSeparator + 1)
  }
}

/**
 * @param {import('googlevideo/protos').FormatId} formatId
 * @param {shaka.extern.BufferedRange} buffered
 * @param {shaka.media.SegmentIndex} segmentIndex
 */
function createBufferedRange(formatId, buffered, segmentIndex) {
  let endSegmentIndex = segmentIndex.find(buffered.end)
  if (endSegmentIndex == null) {
    // Using Last end time will get `null` in `segmentIndex.find`
    endSegmentIndex = segmentIndex.getNumReferences() - 1
  }

  return {
    formatId,
    startTimeMs: String(Math.round(buffered.start * 1000)),
    durationMs: String(Math.round((buffered.end - buffered.start) * 1000)),
    startSegmentIndex: segmentIndex.find(buffered.start),
    endSegmentIndex: endSegmentIndex,
  }
}

/**
 * Creates a bogus buffered range for a format. Used when we want to signal to the server to not send any
 * segments for this format.
 * @param {import('googlevideo/protos').FormatId} formatId - The format to create a full buffer range for.
 * @returns {import('googlevideo/protos').BufferedRange} A BufferedRange object indicating the entire format is buffered.
 */
function createFullBufferRange(formatId) {
  return {
    formatId: formatId,
    durationMs: MAX_INT32_VALUE,
    startTimeMs: '0',
    startSegmentIndex: parseInt(MAX_INT32_VALUE),
    endSegmentIndex: parseInt(MAX_INT32_VALUE),
    timeRange: {
      durationTicks: MAX_INT32_VALUE,
      startTicks: '0',
      timescale: 1000
    }
  }
}

/**
 * @param {shaka.Player} player
 * @param {shaka.extern.Manifest} manifest
 * @param {boolean} audioFormatsActive
 * @param {boolean} streamIsVideo - Fake audio bufferRange can be used
 * @param {boolean} streamIsAudio - Fake video bufferRange can be used
 * @param {import('googlevideo/protos').BufferedRange[]} bufferedRanges
 * @param {shaka.extern.Track} activeVariant
 */
function fillBufferedRanges(player, manifest, audioFormatsActive, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant) {
  const bufferedInfo = player.getBufferedInfo()

  if (bufferedInfo.audio.length > 0 || bufferedInfo.video.length > 0) {
    let activeManifestVariant
    if (audioFormatsActive) {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId
      })
    } else {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId &&
          variant.video.originalId === activeVariant.originalVideoId
      })
    }

    const audioFormatId = formatIdFromString(activeVariant.originalAudioId)
    const audioSegmentIndex = activeManifestVariant.audio.segmentIndex

    if (streamIsVideo) {
      bufferedRanges.push(createFullBufferRange(audioFormatId))
    } else {
      for (const buffered of bufferedInfo.audio) {
        bufferedRanges.push(createBufferedRange(audioFormatId, buffered, audioSegmentIndex))
      }
    }

    // Lazily initialize these variables as video data won't exist for audio-only playback
    let videoFormatId
    let videoSegmentIndex

    if (streamIsAudio && bufferedInfo.video.length > 0) {
      videoFormatId = formatIdFromString(activeVariant.originalVideoId)
      bufferedRanges.push(createFullBufferRange(videoFormatId))
    } else {
      for (const buffered of bufferedInfo.video) {
        if (!videoFormatId) {
          videoFormatId = formatIdFromString(activeVariant.originalVideoId)
        }

        if (!videoSegmentIndex) {
          videoSegmentIndex = activeManifestVariant.video.segmentIndex
        }

        bufferedRanges.push(createBufferedRange(videoFormatId, buffered, videoSegmentIndex))
      }
    }
  }
}

/**
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {Uint8Array} data
 * @returns {shaka.util.AbortableOperation<shaka.extern.Response>}
 */
function createCacheResponse(uri, request, data) {
  return AbortableOperation.completed({
    data,
    fromCache: true,
    headers: {},
    originalRequest: request,
    originalUri: uri,
    uri
  })
}

/**
 * @param {shaka.util.Error.Code} code
 * @param {...any} args
 */
function createRecoverableNetworkError(code, ...args) {
  return new ShakaError(ShakaError.Severity.RECOVERABLE, ShakaError.Category.NETWORK, code, ...args)
}

/**
 * @param {SabrStreamState} sabrStreamState
 */
function prepareSabrContexts(sabrStreamState) {
  /** @type {SabrContextUpdate[]} */
  const sabrContexts = []
  /** @type {number[]} */
  const unsentSabrContexts = []

  for (const ctxUpdate of sabrStreamState.sabrContexts.values()) {
    if (sabrStreamState.activeSabrContextTypes.has(ctxUpdate.type)) {
      sabrContexts.push(ctxUpdate)
    } else {
      unsentSabrContexts.push(ctxUpdate.type)
    }
  }

  return { sabrContexts, unsentSabrContexts }
}

/**
 * @template T
 * @param {import('googlevideo/shared-types').Part} part
 * @param {{ decode: (data: Uint8Array) => T }} decoder
 * @returns {T | undefined}
 */
function decodePart(part, decoder) {
  if (!part.data.chunks.length) return undefined

  try {
    const chunk = part.data.chunks.length === 1 ? part.data.chunks[0] : concatenateChunks(part.data.chunks)
    return decoder.decode(chunk)
  } catch {
    return undefined
  }
}

/**
 * @param {(args: void) => void} callback
 * @param {number} timeoutMs
 * @return TimeoutController
 */
function createTimeoutController(callback, timeoutMs) {
  return {
    _timeout: setTimeout(callback, timeoutMs),
    _resetCount: 0,
    resetTimeoutOnce() {
      if (this._resetCount > 0) return

      this.clearTimeout()
      this._timeout = setTimeout(callback, timeoutMs)
      this._resetCount++
    },
    clearTimeout() {
      clearTimeout(this._timeout)
    },
  }
}

/**
 * @param {OperationInputs} operationInputs - readonly
 * @param {CurrentState} currentState - can be updated
 */
async function doRequest(
  operationInputs,
  currentState,
) {
  let response
  /** @type {CompositeBuffer | null} */
  let chunkedDataBuffer = null
  /** @type {Uint8Array[]} */
  const responseDataChunks = []
  let segmentComplete = false
  let shouldRetry = false
  let shouldRetryDueToNextRequestPolicy = false
  /**
   * Which format IDs the server actually offered, for the retry diagnostic at
   * the end of this function. A response that never yields a matching
   * MEDIA_HEADER completes no segment, and the only visible symptom used to be a
   * 401 a hundred retries later, with nothing saying why.
   * @type {string[]}
   */
  const offeredFormatIds = []
  /**
   * Whether a MEDIA_HEADER in this response matched the requested format. Kept
   * out here so the retry diagnostic can tell "nothing matched" apart from
   * "matched, but the response never finished the segment". Those have different
   * causes and the same symptom.
   */
  let matchedRequestedFormat = false

  let invalidPoToken = false
  let error

  if (currentState.sabrStreamState.playerReloadRequested) {
    // Multiple requests might be issued at the same time, other requests should abort themselves once reload requested
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  try {
    let shouldReloadDueToBackoffLoop = false
    if ((currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs || 0) > 0) {
      const currentBackoffTimeMs = currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.eventEmitter.emit('backoff-requested', { backoffMs: currentBackoffTimeMs })
      // Wait but can be aborted
      await new Promise((resolve, reject) => {
        setTimeout(resolve, currentBackoffTimeMs)
        currentState.abortController.signal.addEventListener('abort', reject)
      })
      // Must reset AFTER waiting to avoid requested aborted
      // Since long backoff time mostly happens on the start of video playback we only reset timeout once
      // i.e. backoff time parts received will not reset timeout - counted as video loading issue
      currentState.timeoutController?.resetTimeoutOnce()

      currentState.cumulativeBackOffTimeMs += currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.cumulativeBackOffRequested += 1
      const timeoutMs = operationInputs.request.retryParameters.timeout
      // Detect infinite backoff loop by no. of times requested and cumulative time approaching timeout
      if (currentState.cumulativeBackOffRequested >= 3 || (timeoutMs > 0 && timeoutMs <= (currentState.cumulativeBackOffTimeMs + currentBackoffTimeMs))) {
        shouldReloadDueToBackoffLoop = true
      }
    }
    if (shouldReloadDueToBackoffLoop || currentState.cumulativeRetryDueToNextRequestPolicy >= 100) {
      // Fire fake reload event due to detecting retry loop
      currentState.sabrStreamState.playerReloadRequested = true
      if (!currentState.abortController.signal.aborted) {
        currentState.abortController.abort()
        currentState.eventEmitter.emit('reload')
      }
    }

    const sabrURL = new URL(currentState.sabrStreamState.sabrUrl)
    sabrURL.searchParams.set('rn', String(currentState.sabrStreamState.requestNumber++))

    const previousRequestAtMs = currentState.sabrStreamState.lastRequestAtMs
    currentState.sabrStreamState.lastRequestAtMs = Date.now()

    response = await fetch(sabrURL.toString(), currentState.requestInit)

    if (response.status === 401) {
      // A 401 here means YouTube rejected the SABR request itself, and it says
      // nothing about why in the body. Three things are worth knowing, and none
      // of them was visible before:
      //
      // - `www-authenticate`. If it is present then Chromium treated this as an
      //   auth challenge and ran the `app.on('login')` path in the main process,
      //   which only intercepts proxy challenges and otherwise lets Electron
      //   cancel the authentication. That would make the body unreadable here
      //   even when the server did send one, so an "empty body" is not proof
      //   that YouTube stayed silent.
      // - The gap since the previous request against the server's own
      //   `maxTimeSinceLastRequestMs`. That is the only timing constraint the
      //   protocol declares, no reference client honours it, and this fork keeps
      //   hidden tabs and their paused players alive, so exceeding it is easy.
      // - The retry count, because a 401 that arrives at the end of a retry
      //   flood is a rate response rather than a credential problem.
      try {
        const reason = (await response.text()).trim()
        const gapMs = previousRequestAtMs ? Date.now() - previousRequestAtMs : undefined
        const maxGapMs = currentState.sabrStreamState.nextRequestPolicy?.maxTimeSinceLastRequestMs

        console.error(
          `SABR request rejected with 401. Reason from YouTube: ${reason.slice(0, 500) || '(empty body)'}\n` +
          `  www-authenticate: ${response.headers.get('www-authenticate') ?? '(absent)'}\n` +
          `  gap since previous request: ${gapMs ?? 'n/a'}ms, server maxTimeSinceLastRequestMs: ${maxGapMs ?? '(not sent)'}\n` +
          `  retries so far on this stream: ${currentState.cumulativeRetryDueToNextRequestPolicy}, rn=${currentState.sabrStreamState.requestNumber - 1}`
        )
      } catch (bodyError) {
        console.error('SABR request rejected with 401. Response body was unreadable.', bodyError)
      }

      if (!currentState.sabrStreamState.playerReloadRequested) {
        currentState.sabrStreamState.playerReloadRequested = true
        if (!currentState.abortController.signal.aborted) {
          currentState.abortController.abort()
          currentState.eventEmitter.emit('reload')
        }
      }
      throw createRecoverableNetworkError(
        ShakaError.Code.OPERATION_ABORTED,
        operationInputs.uri,
        operationInputs.requestType,
      )
    }

    operationInputs.headersReceived({})

    const { itag, lastModified, xtags } = formatIdFromString(operationInputs.formatIdString)
    let mediaHeaderId

    const reader = response.body.getReader()
    let readObj = await reader.read()

    while (!readObj.done && !currentState.abortStatus.finished) {
      if (chunkedDataBuffer) {
        chunkedDataBuffer.append(readObj.value)
      } else {
        chunkedDataBuffer = new CompositeBuffer([readObj.value])
      }

      const remainingData = new UmpReader(chunkedDataBuffer).read((part) => {
        switch (part.type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(part, StreamProtectionStatus)
            if (streamProtectionStatus.status === 3) {
              invalidPoToken = true
            }
            break
          }
          case UMPPartId.SABR_ERROR: {
            const sabrError = decodePart(part, SabrError)
            if (!sabrError) break

            error = `SABR Error: type: ${sabrError.type}, code: ${sabrError.code}`
            break
          }
          case UMPPartId.SABR_REDIRECT: {
            const sabrRedirect = decodePart(part, SabrRedirect)
            if (!sabrRedirect) break

            // The URL that requests are built from is sabrStreamState.sabrUrl.
            // This used to assign to currentState.sabrUrl, which nothing reads,
            // so every redirect was dropped: the retry below reissued the same
            // request to the host YouTube had just moved us off, and that host
            // answers 401. Playback survived until the first redirect, which is
            // why the failures appeared a hundred requests into a stream.
            // googlevideo's own SabrStream.handleSabrRedirect does the same
            // assignment, guarded the same way.
            if (sabrRedirect.url) {
              currentState.sabrStreamState.sabrUrl = sabrRedirect.url
            }
            shouldRetry = true
            break
          }
          case UMPPartId.MEDIA_HEADER: {
            if (mediaHeaderId === undefined) {
              const mediaHeader = decodePart(part, MediaHeader)
              if (!mediaHeader) break

              offeredFormatIds.push(
                `${mediaHeader.formatId.itag}-${mediaHeader.formatId.lastModified}-${mediaHeader.formatId.xtags}` +
                `@seq=${mediaHeader.sequenceNumber}${mediaHeader.isInitSeg ? ' init' : ''}`
              )

              if (
                mediaHeader.formatId.itag === itag &&
                mediaHeader.formatId.lastModified === lastModified &&
                mediaHeader.formatId.xtags === xtags
              ) {
                if (operationInputs.isInit && mediaHeader.isInitSeg) {
                  mediaHeaderId = mediaHeader.headerId
                  matchedRequestedFormat = true
                } else if (!operationInputs.isInit && mediaHeader.sequenceNumber === operationInputs.sequenceNumber) {
                  mediaHeaderId = mediaHeader.headerId
                  matchedRequestedFormat = true
                }
              }
            }

            break
          }
          case UMPPartId.MEDIA: {
            if (mediaHeaderId === part.data.getUint8(0)) {
              responseDataChunks.push(...part.data.split(1).remainingBuffer.chunks)
            }
            break
          }
          case UMPPartId.MEDIA_END: {
            if (mediaHeaderId === part.data.getUint8(0)) {
              segmentComplete = true
              currentState.abortStatus.finished = true
              currentState.abortController.abort()
            }
            break
          }
          case UMPPartId.NEXT_REQUEST_POLICY: {
            const nextRequestPolicy = decodePart(part, NextRequestPolicy)

            shouldRetry = true
            shouldRetryDueToNextRequestPolicy = true

            currentState.sabrStreamState.nextRequestPolicy = nextRequestPolicy

            // Echo the cookie back exactly as it arrived. See extractRawField
            // for why decoding and re-encoding it corrupts the session.
            const rawPolicy = part.data.chunks.length === 1
              ? part.data.chunks[0]
              : concatenateChunks(part.data.chunks)
            currentState.sabrStreamState.playbackCookieBytes =
              extractRawField(rawPolicy, PLAYBACK_COOKIE_FIELD_NUMBER)
            currentState.abrRequest.streamerContext.playbackCookie =
              currentState.sabrStreamState.playbackCookieBytes

            currentState.abrRequest.streamerContext.backoffTimeMs = nextRequestPolicy?.backoffTimeMs
            break
          }
          case UMPPartId.FORMAT_INITIALIZATION_METADATA: {
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(part, SabrContextUpdate)
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              if (
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)
              ) {
                break
              }

              currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_SENDING_POLICY: {
            const sabrContextSendingPolicy = decodePart(part, SabrContextSendingPolicy)
            if (!sabrContextSendingPolicy) break

            for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
              if (!currentState.sabrStreamState.activeSabrContextTypes.has(startPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.add(startPolicy)
              }
            }

            for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
              if (currentState.sabrStreamState.activeSabrContextTypes.has(stopPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.delete(stopPolicy)
              }
            }

            for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
              if (currentState.sabrStreamState.sabrContexts.has(discardPolicy)) {
                currentState.sabrStreamState.sabrContexts.delete(discardPolicy)
              }
            }
            break
          }
          case UMPPartId.RELOAD_PLAYER_RESPONSE: {
            const reloadPlaybackContext = decodePart(part, ReloadPlaybackContext)
            if (!reloadPlaybackContext) break

            // Whole video cannot be played
            currentState.sabrStreamState.playerReloadRequested = true
            if (!currentState.abortController.signal.aborted) {
              currentState.abortController.abort()
              currentState.eventEmitter.emit('reload')
            }
            break
          }
          default: {
            break
          }
        }
      })

      if (!currentState.abortStatus.finished) {
        if (remainingData) {
          chunkedDataBuffer = remainingData.data
        } else {
          chunkedDataBuffer = null
        }

        readObj = await reader.read()
      }
    }
  } catch (error) {
    if (currentState.abortStatus.cancelled) {
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    } else if (currentState.abortStatus.timedOut) {
      throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
    } else if (!currentState.abortStatus.finished) {
      throw createRecoverableNetworkError(ShakaError.Code.HTTP_ERROR, operationInputs.uri, error, operationInputs.requestType)
    }
  }

  if (currentState.abortStatus.cancelled) {
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  } else if (currentState.abortStatus.timedOut) {
    throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
  }

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

    if (operationInputs.isInit) {
      currentState.initDataCache.set(operationInputs.formatIdString, data)
    }

    /** @type {shaka.extern.Response} */
    return {
      uri: operationInputs.uri,
      originalUri: operationInputs.uri,
      data,
      status: response.status,
      headers: {},
      fromCache: false,
      originalRequest: operationInputs.request,
    }
  } else if (shouldRetry) {
    if (shouldRetryDueToNextRequestPolicy) {
      // Only count on actual retry to avoid counting false positive (when segmentComplete
      currentState.cumulativeRetryDueToNextRequestPolicy += 1

      // Retries here are expected, not an error. SABR is server-driven: it
      // returns a window of segments near where it believes the player is, and
      // it will not jump more than roughly 30 to 60 seconds ahead. shaka asks
      // for one specific segment, so after a seek it asks for one past that
      // window, and these retries are the plugin waiting for the window to
      // reach it. Measured on a live stream: playerTimeMs of 0, 5s, 15s and 30s
      // all return media, and 60s and beyond return a policy-only response with
      // no media at all.
      //
      // Only speak up once the count is closing on the cap of 100, where the
      // wait has stopped looking like a wait and the reload is coming.
      if (currentState.cumulativeRetryDueToNextRequestPolicy === 50) {
        const wanted = formatIdFromString(operationInputs.formatIdString)
        console.warn(
          `SABR has not reached the requested segment after 50 retries; a reload is due at 100. ${matchedRequestedFormat
            ? 'The format matched, but the response never sent MEDIA_END.'
            : 'No MEDIA_HEADER in the response matched the requested format.'}\n` +
          `  wanted: itag=${wanted.itag} lastModified=${wanted.lastModified} xtags=${JSON.stringify(wanted.xtags)}` +
          `${operationInputs.isInit ? ' init' : ` seq=${operationInputs.sequenceNumber}`}\n` +
          `  offered in this response: ${offeredFormatIds.length ? offeredFormatIds.join(', ') : '(no MEDIA_HEADER parts)'}\n` +
          `  matched: ${matchedRequestedFormat}, media chunks collected: ${responseDataChunks.length}, segment complete: ${segmentComplete}`
        )
      }
    }

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(currentState.sabrStreamState)

    currentState.abrRequest.streamerContext.sabrContexts = sabrContexts
    currentState.abrRequest.streamerContext.unsentSabrContexts = unsentSabrContexts

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(currentState.abrRequest).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', currentState.abrRequest)
      throw error
    }

    currentState.requestInit = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: currentState.abortController.signal,
    }
    currentState.abortStatus.timedOut = false

    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (invalidPoToken) {
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.NETWORK,
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Invalid PO token'),
      operationInputs.requestType,
    )
  } else if (error) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error(error),
      operationInputs.requestType,
    )
  } else if (responseDataChunks.length > 0 && !segmentComplete) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Incomplete segment, missing MEDIA_END part'),
      operationInputs.requestType,
    )
  } else if (response.status === 200) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Empty response, this should not happen'),
      operationInputs.requestType,
    )
  } else {
    const severity = response.status === 403
      ? ShakaError.Severity.CRITICAL
      : ShakaError.Severity.RECOVERABLE

    throw new ShakaError(
      severity,
      ShakaError.Category.NETWORK,
      ShakaError.Code.BAD_HTTP_STATUS,
      operationInputs.uri,
      response.status,
      '',
      {},
      operationInputs.requestType,
      operationInputs.uri,
    )
  }
}

/**
 * @param {import('../../views/Watch/Watch').SabrData} sabrData
 * @param {() => shaka.Player} getPlayer
 * @param {() => shaka.extern.Manifest} getManifest
 * @param {import('vue').ComputedRef<number>} playerWidth
 * @param {import('vue').ComputedRef<number>} playerHeight
 * @return SabrStream
 */
export function setupSabrScheme(sabrData, getPlayer, getManifest, playerWidth, playerHeight) {
  const streamId = sabrData.streamId
  const eventEmitter = new EventEmitterLike()

  /**
   * Caches the init data until the video ends
   * that way changing qualities and between audio and DASH
   * doesn't have to fetch the init data and segment index again
   * @type {Map<string, Uint8Array>}
   */
  const initDataCache = new Map()

  const poToken = base64ToU8(sabrData.poToken)
  const videoPlaybackUstreamerConfig = base64ToU8(sabrData.ustreamerConfig)
  const clientInfo = deepCopy(sabrData.clientInfo)

  /** @type {SabrStreamState} */
  const sabrStreamState = {
    sabrUrl: sabrData.url,
    activeSabrContextTypes: new Set(),
    sabrContexts: new Map(),
    nextRequestPolicy: undefined,
    playbackCookieBytes: undefined,
    playerReloadRequested: false,
    requestNumber: 0,
    lastRequestAtMs: undefined,
  }

  sabrHandlers.set(streamId, (uri, request, requestType, _progressUpdated, headersReceived, _config) => {
    // lazily fetch it as the variable is only set after setupSabrScheme is called
    // but it will definitely exist when we receive a request here.
    const player = getPlayer()
    if (player == null) {
      // This is true during reload, returning a promise to suppress error
      return new AbortableOperation(Promise.resolve(createAbandonedResponse(uri, request)))
    }

    let isAudioOnly
    try {
      isAudioOnly = player.isAudioOnly()
    } catch {
      // A null check is not enough here. `player` is shaka's cast proxy, and
      // destroying the UI nulls the cast sender behind it while the proxy object
      // itself stays reachable, so every property access throws
      // "Cannot read properties of null (reading 'Wa')" from inside the proxy's
      // get trap. That happens when a request queued before a tab switch or a
      // reload runs after the teardown. Treat it exactly like the null case.
      return new AbortableOperation(Promise.resolve(createAbandonedResponse(uri, request)))
    }

    const url = new URL(request.uris[0])

    const isInit = url.searchParams.has('init')
    const formatIdString = url.searchParams.get('formatId')

    if (isInit && initDataCache.has(formatIdString)) {
      return /** @__NOINLINE__ */ createCacheResponse(uri, request, initDataCache.get(formatIdString))
    }

    const variantTracks = player.getVariantTracks()
    const activeVariant = variantTracks.find(track => track.active)

    const streamIsAudio = url.pathname === 'audio'
    const streamIsVideo = url.pathname === 'video'

    let audioFormatId
    let videoFormatId

    if (streamIsAudio) {
      audioFormatId = formatIdFromString(formatIdString)

      if (isAudioOnly) {
        // We need to specify a video format even for audio only otherwise we get an error response
        videoFormatId = formatIdFromString(url.searchParams.get('videoFormatId'))
      } else {
        videoFormatId = formatIdFromString((activeVariant ?? variantTracks[0]).originalVideoId)
      }
    } else if (streamIsVideo) {
      videoFormatId = formatIdFromString(formatIdString)

      // for the first fetching of the initial data there won't be an active variant
      // (shaka-player only sets it to active after it has fetched the init/segment data)
      if (activeVariant) {
        audioFormatId = formatIdFromString(activeVariant.originalAudioId)
      } else {
        const candidates = variantTracks.filter((track) => track.audioRoles.includes('main'))

        const probableAudioFormat = candidates.reduce((previous, current) => {
          return current.audioBandwidth >= previous.audioBandwidth ? current : previous
        }, candidates[0])

        audioFormatId = formatIdFromString(probableAudioFormat.originalAudioId)
      }
    }

    /** @type {import('googlevideo/protos').BufferedRange[]} */
    const bufferedRanges = []

    if (!isInit && activeVariant) {
      /** @__NOINLINE__ */ fillBufferedRanges(player, getManifest(), isAudioOnly, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant)
    }

    let playerTimeMs = '0'

    if (url.searchParams.has('startTimeMs')) {
      playerTimeMs = url.searchParams.get('startTimeMs')
    }

    const drcEnabled = url.searchParams.has('drc') || !!(activeVariant && activeVariant.audioRoles.includes('drc'))
    const enableVoiceBoost = url.searchParams.has('vb') || !!(activeVariant && activeVariant.audioRoles.includes('vb'))

    const resolution = streamIsVideo ? parseInt(url.searchParams.get('resolution')) : undefined

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(sabrStreamState)

    /** @type {VideoPlaybackAbrRequest} */
    const requestData = {
      clientAbrState: {
        bandwidthEstimate: String(Math.round(player.getStats().estimatedBandwidth)),
        timeSinceLastManualFormatSelectionMs: streamIsVideo ? '0' : undefined,
        stickyResolution: resolution,
        lastManualSelectedResolution: resolution,
        playbackRate: player.getPlaybackRate(),
        enabledTrackTypesBitfield: streamIsAudio ? 1 : 0,
        drcEnabled,
        enableVoiceBoost,
        playerTimeMs,
        clientViewportWidth: playerWidth.value,
        clientViewportHeight: playerHeight.value,
        clientViewportIsFlexible: false
      },
      preferredAudioFormatIds: [audioFormatId],
      preferredVideoFormatIds: [videoFormatId],
      preferredSubtitleFormatIds: [],
      selectedFormatIds: isInit ? [] : [audioFormatId, videoFormatId],
      bufferedRanges,
      streamerContext: {
        poToken,
        clientInfo,
        sabrContexts,
        unsentSabrContexts,
        // Verbatim bytes, never a re-encode. See extractRawField.
        playbackCookie: sabrStreamState.playbackCookieBytes,
      },
      field1000: [],
      videoPlaybackUstreamerConfig,
    }

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(requestData).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', requestData)
      throw error
    }

    const sequenceNumber = parseInt(url.searchParams.get('sq'))

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {OperationInputs}
     */
    const opInputs = {
      uri,
      request,
      requestType,
      headersReceived,

      formatIdString,
      isInit,
      sequenceNumber,
    }

    const abortController = new AbortController()

    /** @type {RequestInit} */
    const init = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: abortController.signal,
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {AbortStatus}
     */
    const abortStatus = {
      cancelled: false,
      timedOut: false,
      finished: false,
    }

    const timeoutMs = request.retryParameters.timeout
    let timeoutController = null
    if (timeoutMs) {
      timeoutController = createTimeoutController(() => {
        abortStatus.timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {CurrentState}
     */
    const currentState = {
      initDataCache,
      abrRequest: requestData,
      requestInit: init,
      abortStatus: abortStatus,
      abortController,
      sabrStreamState,
      timeoutController,
      eventEmitter,
      cumulativeBackOffTimeMs: 0,
      cumulativeBackOffRequested: 0,
      cumulativeRetryDueToNextRequestPolicy: 0,
    }

    const pendingRequest = doRequest(opInputs, currentState)

    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.cancelled = true
      abortController.abort()
      return Promise.resolve()
    })

    if (timeoutController) {
      op.finally(() => {
        timeoutController.clearTimeout()
      })
    }

    return op
  })

  if (!schemeRegistered) {
    shaka.net.NetworkingEngine.registerScheme('sabr', (uri, request, requestType, progressUpdated, headersReceived, config) => {
      const url = new URL(request.uris[0])
      const sid = url.searchParams.get('sid')
      const handler = sid ? sabrHandlers.get(sid) : sabrHandlers.values().next().value
      if (!handler) {
        return new AbortableOperation(Promise.resolve(createAbandonedResponse(uri, request)))
      }
      return handler(uri, request, requestType, progressUpdated, headersReceived, config)
    })
    schemeRegistered = true
  }

  const cleanup = () => {
    sabrHandlers.delete(streamId)
    if (sabrHandlers.size === 0) {
      shaka.net.NetworkingEngine.unregisterScheme('sabr')
      schemeRegistered = false
    }
    initDataCache.clear()
  }

  return {
    onBackoffRequested(callback) {
      eventEmitter.on('backoff-requested', callback)
    },
    onReloadOnce(callback) {
      eventEmitter.once('reload', callback)
    },
    cleanup,
  }
}
