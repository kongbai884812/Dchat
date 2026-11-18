import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import { transcribe } from '../../services/api/speech.js'
import {
  primeMicrophone,
  releaseWarmMicrophone,
  startRecording,
  type Recording,
} from '../../services/speech/recorder.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import { trace } from '../../services/speech/trace.js'

export type PushToTalkStatus = 'idle' | 'recording' | 'transcribing'

/** 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://） */
const AVAILABLE = typeof window === 'undefined' || window.isSecureContext

/** 比这还短的录音不送识别，和官方 App 的“说话时间太短”一致 */
const MIN_MS = 700

const describeError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

/**
 * 按住说话：按下开始录音，松手结束并转写，结果交给 onTranscript。
 * 上滑取消由调用方决定，canceled 为 true 时只是释放麦克风，不做识别。
 */
export const usePushToTalk = (onTranscript: (text: string) => void) => {
  const [status, setStatus] = useState<PushToTalkStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  /** 手指是否还按着；权限弹窗慢于松手时用它放弃这次录音 */
  const heldRef = useRef(false)
  const startedAtRef = useRef(0)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const cancelOperation = useCallback(() => {
    operationRef.current++
    recordingRef.current?.cancel()
    recordingRef.current = null
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const cancel = useCallback(() => {
    heldRef.current = false
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  /** 松手：canceled 时直接丢掉录音，否则转写后交给页面 */
  const finish = useCallback(
    async (canceled: boolean) => {
      heldRef.current = false
      const recording = recordingRef.current
      if (!recording) {
        // 还在等麦克风授权，松手就当作没录过
        trace('finish-nogum')
        cancel()
        return
      }
      recordingRef.current = null
      const operation = operationRef.current
      const elapsed = Date.now() - startedAtRef.current
      trace(`finish canceled=${canceled} elapsed=${elapsed} hasRecording=1`)

      if (canceled) {
        recording.cancel()
        setStatus('idle')
        return
      }
      if (elapsed < MIN_MS) {
        recording.cancel()
        setStatus('idle')
        showToast({ key: 'voiceTooShort' })
        return
      }

      let controller: AbortController | null = null
      try {
        let audio: Blob | null
        try {
          audio = await recording.stop()
        } finally {
          recording.cancel()
        }
        if (operationRef.current !== operation || !audio) {
          return
        }
        controller = new AbortController()
        controllerRef.current = controller
        setStatus('transcribing')
        trace(`asr-post bytes=${audio.size}`)
        const text = await transcribe(useSettings.getState().apiKey ?? '', audio, controller.signal)
        if (controller.signal.aborted || operationRef.current !== operation) {
          return
        }
        if (text.trim()) {
          onTranscriptRef.current(text.trim())
        } else {
          showToast({ key: 'voiceInputEmpty' })
        }
      } catch {
        if (operationRef.current === operation && !controller?.signal.aborted) {
          showToast({ key: 'voiceInputFailed' })
        }
      } finally {
        if (operationRef.current === operation) {
          controllerRef.current = null
          setStatus('idle')
        }
      }
    },
    [cancel]
  )

  /** 按下：开始录音；权限被拒或设备没有麦克风时提示后回到空闲 */
  const start = useCallback(async () => {
    if (!AVAILABLE) {
      showToast({ key: 'voiceInputRequiresHttps' })
      return
    }
    if (status !== 'idle') {
      return
    }
    heldRef.current = true
    startedAtRef.current = Date.now()
    trace(`start secure=${window.isSecureContext} mediaDevices=${Boolean(navigator.mediaDevices)}`)
    const operation = ++operationRef.current
    setStatus('recording')
    try {
      const recording = await startRecording(() => {
        if (operationRef.current === operation && heldRef.current) {
          showToast({ key: 'voiceInputLimitReached' })
          void finish(false)
        }
      })
      if (operationRef.current !== operation || !heldRef.current) {
        // 等权限的时候已经松手了
        recording.cancel()
        if (operationRef.current === operation) {
          setStatus('idle')
        }
        return
      }
      recordingRef.current = recording
      trace(`gum-ok state=${recording.analyser.context.state}`)
    } catch (error) {
      const e = error as { name?: string; message?: string }
      trace(`start-fail ${e?.name ?? '?'} ${e?.message ?? ''}`)
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeError(error))
      }
    }
  }, [status, finish])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = startedAtRef.current
    setSeconds(0)
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])

  /** 进入语音模式时预热麦克风，按下即可收音 */
  const warm = useCallback(() => {
    void primeMicrophone()
  }, [])

  /** 退出语音模式：关掉预热流 */
  const release = useCallback(() => {
    releaseWarmMicrophone()
  }, [])

  return { status, seconds, start, finish, cancel, warm, release, available: AVAILABLE }
}
