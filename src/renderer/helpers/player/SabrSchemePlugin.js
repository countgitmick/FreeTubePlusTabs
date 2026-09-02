import { base64ToU8, concatenateChunks, EnabledTrackTypes, EventEmitterLike, MAX_INT32_VALUE } from 'googlevideo/utils'
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
  SnackbarMessage,
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
 * @property {string} streamKind "audio" or "video"
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
 * @property {boolean} retryWarned whether the closing-on-the-cap warning ran
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
 * @property {Set<string>} deliveredMediaFor stream kinds, "audio" or "video",
 *   that this session has actually sent media for. Per kind, not per session:
 *   audio and video share one sabrStreamState, so a single flag lets a healthy
 *   audio stream mark the session good and disable the video stream's recovery
 * @property {boolean} refusalLogged whether the one refusal diagnostic has
 *   already been printed for this stream
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
 * @property {(cb: (reason: string) => void) => void} onReloadOnce
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
 * NEVER call `player.configure()` from this file.
 *
 * A version of this plugin matched shaka's buffering goal to the readahead the
 * server advertises, called from the NEXT_REQUEST_POLICY branch. It broke
 * playback outright on 2026-08-02, and shaka's own source says why.
 * `Player.configure` runs `applyConfig_`, which calls `this.parser_.configure()`,
 * `filterManifestWithRestrictions`, `updateAbrManagerVariants_` and
 * `chooseVariantAndSwitch_`.
 *
 * This code runs inside a UMP response callback. During `createMediaSegmentIndex`
 * that callback reconfigures the manifest parser while the parser is awaiting the
 * very request being parsed, and it can switch the variant out from under the
 * format the request asked for. No segment then completes, which produces another
 * policy, which configures again. The video never started and the buffer stayed
 * at 0.1s.
 *
 * Player configuration belongs to ft-shaka-video-player, which owns the player
 * and is not reentrant with it.
 */

/**
 * How long a session may pace us while delivering no media at all, before the
 * player asks for a fresh one.
 *
 * This only fires when the session has never delivered a byte, so a healthy
 * stream with a full buffer never reaches it however long it is paced. The
 * measured failure sits well inside it: a 2000ms backoff repeated forever on the
 * segment index fetch, which leaves the video at 0.1s buffered and never starts.
 *
 * The old code used a count of three, which is six seconds at that rate, and it
 * fired on healthy sessions constantly. That was the reload loop.
 */
const BACKOFF_WITHOUT_MEDIA_BUDGET_MS = 20_000

/**
 * The same bound counted in rounds rather than milliseconds.
 *
 * A time budget alone never fires when the server paces with tiny backoffs, and
 * 3ms values were measured. Upstream FreeTube uses a count of three here, which
 * is reachable but far too eager on its own. Double it, and rely on
 * the delivered-media check to keep a healthy stream out of this branch.
 */
const BACKOFF_ROUNDS_WITHOUT_MEDIA = 6

/**
 * How much server backoff a media-less stream must accumulate before the plugin
 * says anything.
 *
 * Counting refusals was the wrong measure. A healthy start produces several, and
 * their backoffs are trivial: 3ms was measured on a load that then played
 * perfectly. Time spent getting nowhere is the thing that distinguishes a stuck
 * session, and it is already tracked for the reload budget.
 *
 * Half the reload budget, so the report lands before the reload rather than with
 * it.
 */
const REFUSAL_REPORT_AFTER_MS = BACKOFF_WITHOUT_MEDIA_BUDGET_MS / 2

/**
 * Where the retry count is close enough to the cap of 100 to be worth a word.
 */
const RETRY_WARN_AT = 50

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

  /**
   * Whether this response carried a SABR context that the next request has to
   * echo back. The reference implementation retries on this alone when the
   * response held no media, because the retry is what delivers the context.
   */
  let contextUpdateNeedsRetry = false

  /** What YouTube said to the user in place of media, if anything. */
  let snackbarMessage = null

  /**
   * Every UMP part id in this response, in order, collected only while the
   * session has never delivered media. It is the one thing that says what the
   * server sent instead of the segment, and the plugin used to parse it and throw
   * it away.
   * @type {string[]}
   */
  const seenPartTypes = []

  let invalidPoToken = false
  let error

  if (currentState.sabrStreamState.playerReloadRequested) {
    // Multiple requests might be issued at the same time, other requests should abort themselves once reload requested
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  try {
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

      currentState.cumulativeBackOffTimeMs += currentBackoffTimeMs
      currentState.cumulativeBackOffRequested += 1

      // A backoff is an instruction, not a fault, and it never asks for a player
      // reload any more.
      //
      // This used to reload after the third one. That is the loop measured on
      // 2026-08-02: YouTube paces a fresh session, the third backoff gets called
      // an infinite loop, the player reloads, and the new session is paced the
      // same way. A reload cannot fix pacing, and a fresh session earns more of
      // it. The same applies to a bound on the accumulated wait, because the
      // wait is what the server asked for.
      //
      // What the backoff does bound is a session that delivers nothing at all.
      // Measured 2026-08-02: the segment index fetch at load was answered with a
      // 2000ms backoff and no media, over and over, so the video never started
      // and the buffer sat at 0.1s. A fresh session does fix that one, because
      // the session itself is what is broken. See BACKOFF_WITHOUT_MEDIA_BUDGET_MS.
      // Nothing is logged here. Backing off is the server pacing a healthy
      // session, and it happens on an ordinary start, so a line at any fixed
      // count is noise on a console that must stay readable. A session that is
      // genuinely stuck is reported once by the refusal diagnostic below, and a
      // session that gives up prints its reason through the reload funnel.
    }
    // Every reload carries the reason that produced it. Several paths reach the
    // one reload funnel in the watch view, they fail in different ways, and
    // telling them apart from a stack trace alone cost a whole diagnosis.
    let reloadReason = null

    if (currentState.cumulativeRetryDueToNextRequestPolicy >= 100) {
      reloadReason = 'the requested segment never arrived in 100 retries'
    } else if (
      !currentState.sabrStreamState.deliveredMediaFor.has(operationInputs.streamKind) &&
      (
        currentState.cumulativeBackOffRequested >= BACKOFF_ROUNDS_WITHOUT_MEDIA ||
        currentState.cumulativeBackOffTimeMs >= BACKOFF_WITHOUT_MEDIA_BUDGET_MS
      )
    ) {
      // Paced this hard and the session has never delivered a single byte of
      // media. That is a broken session rather than flow control, and a fresh one
      // is what fixes it. Upstream FreeTube reloads here too, on a count of three
      // backoffs, and that reload is how it escapes a session anchored away from
      // the requested position.
      //
      // The delivered-media half is ours, and it is the whole difference.
      // Upstream trips on the count alone, so a healthy stream that is merely
      // paced reloads itself, which is the loop measured on 2026-08-02.
      //
      // Both a count and a time bound, because either shape occurs. Large
      // backoffs reach the time bound first. Small ones, 3ms measured, never
      // accumulate time at all and only the count catches them.
      reloadReason = `the session delivered no media in ${currentState.cumulativeBackOffRequested} backoffs ` +
        `totalling ${currentState.cumulativeBackOffTimeMs}ms`
    }

    if (reloadReason) {
      // Fire fake reload event due to detecting retry loop
      currentState.sabrStreamState.playerReloadRequested = true
      if (!currentState.abortController.signal.aborted) {
        currentState.abortController.abort()
        currentState.eventEmitter.emit('reload', reloadReason)
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
          currentState.eventEmitter.emit('reload', 'YouTube rejected the request with 401')
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
        // Record what the server actually sent, but only while the session has
        // never delivered a byte of media. That is the broken case, and it is the
        // only one worth the array. Once media flows the guard is a single
        // boolean read per part, and the array stops growing.
        if (!currentState.sabrStreamState.deliveredMediaFor.has(operationInputs.streamKind) && seenPartTypes.length < 40) {
          seenPartTypes.push(UMPPartId[part.type] ?? part.type)
        }

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
              // Recorded against this request's own stream kind, inside the
              // header match. Both halves matter. `sabrStreamState` is shared by
              // the audio and the video request, so one flag lets a healthy audio
              // stream mark the whole session good and disable the video stream's
              // recovery. The header match then keeps media for a format we did
              // not ask for out of it.
              currentState.sabrStreamState.deliveredMediaFor.add(operationInputs.streamKind)
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
          case UMPPartId.SNACKBAR_MESSAGE: {
            // YouTube only sends this when it wants to say something to the user,
            // and it says it in place of media. Left undecoded, a refusal looks
            // like a pacing problem. Decoded, it names itself.
            if (!currentState.sabrStreamState.deliveredMediaFor.has(operationInputs.streamKind)) {
              // Not JSON.stringify(x ?? null): that yields the string "null",
              // which is truthy, so the '(none)' fallback below never runs.
              const decoded = decodePart(part, SnackbarMessage)
              snackbarMessage = decoded ? JSON.stringify(decoded) : null
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(part, SabrContextUpdate)
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              const alreadyHeld = currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)

              // Storing is conditional. Activating is not, and that separation is
              // the whole point. The early `break` here used to swallow the
              // `sendByDefault` below whenever the server re-sent a context it had
              // already sent, so the context was never echoed back and the server
              // asked again forever. Measured 2026-08-02 on the init request:
              // SABR_CONTEXT_UPDATE, SNACKBAR_MESSAGE, NEXT_REQUEST_POLICY, no
              // media, backoff 4000ms, repeating. googlevideo's own
              // SabrStreamingAdapter activates outside the store condition.
              if (
                !alreadyHeld ||
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.OVERWRITE
              ) {
                currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)
              }

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }

              // A context update is its own reason to go again, exactly as the
              // reference does it. The next request carries the context, which is
              // what the server is waiting for. Without this the only retry came
              // from the policy branch, which pays the server backoff first.
              contextUpdateNeedsRetry = true
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
              currentState.eventEmitter.emit('reload', 'YouTube sent RELOAD_PLAYER_RESPONSE')
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
  } else if (shouldRetry || (contextUpdateNeedsRetry && responseDataChunks.length === 0 && !invalidPoToken && !error)) {
    // The context retry only applies when the response carried no media, which is
    // how googlevideo's own adapter gates it: `if (!response.data?.byteLength)
    // return retry()`. Retrying a response that did deliver media is a free
    // request that can never help.
    //
    // Every retry below also advances `cumulativeRetryDueToNextRequestPolicy`, so
    // the cap of 100 bounds this path too. Without that, a stream of context
    // updates with no policy attached recurses with no delay and no limit,
    // because the backoff wait needs a policy to exist.

    // The refusal itself, reported once per stream.
    //
    // A session that has never delivered media and is retrying is the failure
    // that leaves the video at 0.1s buffered and never starts. Everything needed
    // to name its cause is in scope right here, and the plugin used to discard
    // all of it: what the server sent instead of the segment, which formats it
    // offered against the one we asked for, and any SABR error.
    // A handful of these is the normal opening handshake, not a fault. YouTube
    // answers the first init request per format with a SABR context and no media,
    // and the retry that carries the context back is what starts playback. Those
    // refusals carry a trivial backoff: 3ms was measured on a load that then
    // played perfectly. So the gate is accumulated backoff time, not a count, and
    // nothing is ever said once media has flowed.
    // Gated on accumulated backoff time alone. A retry-count gate was tried and
    // removed: with small backoffs the round counter trips the reload at
    // BACKOFF_ROUNDS_WITHOUT_MEDIA first, so the count was never reached.
    if (
      !currentState.sabrStreamState.deliveredMediaFor.has(operationInputs.streamKind) &&
      !currentState.sabrStreamState.refusalLogged &&
      currentState.cumulativeBackOffTimeMs >= REFUSAL_REPORT_AFTER_MS
    ) {
      currentState.sabrStreamState.refusalLogged = true

      const wanted = formatIdFromString(operationInputs.formatIdString)

      console.warn(
        'SABR refusal, this session has delivered no media at all.\n' +
        `  requested: itag=${wanted.itag} lastModified=${wanted.lastModified} xtags=${JSON.stringify(wanted.xtags)}` +
        `${operationInputs.isInit ? ' init' : ` seq=${operationInputs.sequenceNumber}`}\n` +
        `  server sent parts: ${seenPartTypes.length ? seenPartTypes.join(', ') : '(none)'}\n` +
        `  formats offered: ${offeredFormatIds.length ? offeredFormatIds.join(', ') : '(no MEDIA_HEADER parts)'}\n` +
        `  matched our format: ${matchedRequestedFormat}, sabr error: ${error ?? '(none)'}, ` +
        `invalid po token: ${invalidPoToken}\n` +
        `  http ${response.status}, response bytes collected: ${responseDataChunks.length}, ` +
        `rn=${currentState.sabrStreamState.requestNumber - 1}\n` +
        `  policy: ${JSON.stringify(currentState.sabrStreamState.nextRequestPolicy ?? null)}\n` +
        `  snackbar: ${snackbarMessage ?? '(none)'}`
      )
    }

    // Never hold this request back waiting for the user.
    //
    // A version of this plugin parked a paused player's request until it saw a
    // `play` event. shaka runs one outstanding request per stream, so the park
    // took that stream's only fetch slot for as long as it lasted. Seeks and
    // buffer refills queued behind it, and playback ran on a starved buffer.
    // Measured 2026-08-02: `paused: false, buffered ahead: 0.2s` during normal
    // playback, with seek stacks interleaved with the parked requests.
    //
    // The reload loop is already fixed where it belongs, in the backoff branch
    // near the top of this function. Retrying on the server's own 2000ms to
    // 4000ms backoff is not a flood, and it costs nothing that matters.

    // Counted for every retry, not only the policy driven ones, so that the cap
    // of 100 is a real bound on this whole branch.
    currentState.cumulativeRetryDueToNextRequestPolicy += 1

    if (shouldRetryDueToNextRequestPolicy) {
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
      //
      // A threshold crossing with a one-shot flag, not `=== 50`. The counter now
      // advances for context-update retries too, so an exact match can step past
      // 50 without ever equalling it.
      if (currentState.cumulativeRetryDueToNextRequestPolicy >= RETRY_WARN_AT && !currentState.retryWarned) {
        currentState.retryWarned = true
        const wanted = formatIdFromString(operationInputs.formatIdString)
        console.warn(
          `SABR has not reached the requested segment after ${currentState.cumulativeRetryDueToNextRequestPolicy} retries; a reload is due at 100. ${matchedRequestedFormat
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

    // Do NOT rewrite `playerTimeMs` to the live playhead here.
    //
    // It looks correct, because the server refuses while it believes the client
    // is more than its stated `targetAudioReadaheadMs` ahead, 15000 measured. It
    // is wrong, and it was measured wrong on 2026-08-03. `playerTimeMs` is what
    // tells the server which window to serve, and this request wants one specific
    // segment. Send the playhead and the server offers the segments next to it,
    // so a request for seq=7 is answered with seq=2, 3 and 4, nothing matches the
    // requested format id, and the retry runs to the cap of 100 and reloads.
    //
    // The reference adapter sends `request.segment.getStartTime()` for exactly
    // this reason, and only falls back to the player time when there is no
    // segment. The original value from the URL is that segment start time.

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
    deliveredMediaFor: new Set(),
    refusalLogged: false,
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
        // One track per request, which is what this plugin actually consumes.
        //
        // This used to send 0 for a video request, and 0 is VIDEO_AND_AUDIO. The
        // server was therefore free to answer a video request with audio media,
        // and the mediaHeaderId guard below drops anything that is not the
        // requested format. No segment completes, `shouldRetry` fires, and the
        // loop runs until shaka's deadline expires as TIMEOUT. googlevideo's own
        // adapter sends VIDEO_ONLY or AUDIO_ONLY, never both.
        enabledTrackTypesBitfield: streamIsAudio ? EnabledTrackTypes.AUDIO_ONLY : EnabledTrackTypes.VIDEO_ONLY,
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
      // "audio" or "video". The two share one sabrStreamState, so anything
      // tracked per stream needs this to tell them apart.
      streamKind: url.pathname,
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
      retryWarned: false,
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
