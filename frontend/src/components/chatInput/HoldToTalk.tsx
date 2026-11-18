import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { PushToTalkStatus } from './usePushToTalk.js'
import styles from './HoldToTalk.module.css'

/** 上滑超过这个距离进入取消区，回落到较小时才退出，避免边界抖动 */
const CANCEL_AT = 56
const KEEP_AT = 28

/**
 * 按住说话：按下开始录音、松手发送、上滑取消。
 * 用 Pointer 事件而不是 touch/click，松手时即使手指移出按钮也能收到 pointerup。
 */
export const HoldToTalk = ({
  status,
  seconds,
  onStart,
  onFinish,
}: {
  status: PushToTalkStatus
  seconds: number
  onStart: () => void
  onFinish: (canceled: boolean) => void
}) => {
  const t = useTranslate()
  const [armed, setArmed] = useState(false)
  const startY = useRef(0)
  const pressing = useRef(false)
  const armedRef = useRef(false)

  const recording = status === 'recording'

  const label = recording
    ? armed
      ? t('voiceReleaseToCancel')
      : t('voiceReleaseToSend')
    : status === 'transcribing'
      ? t('voiceTranscribing')
      : t('voiceHoldToTalk')

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={clsx(
          styles.bar,
          recording && styles.recording,
          armed && styles.armed,
          status === 'transcribing' && styles.busy
        )}
        aria-label={label}
        // 长按不要弹出系统菜单 / 选中文字
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (status !== 'idle' || pressing.current) {
            return
          }
          event.preventDefault()
          pressing.current = true
          startY.current = event.clientY
          armedRef.current = false
          setArmed(false)
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // 不支持指针捕获也不影响后续 pointerup
          }
          onStart()
        }}
        onPointerMove={(event) => {
          if (!pressing.current) {
            return
          }
          const dy = startY.current - event.clientY
          const next = armedRef.current ? dy > KEEP_AT : dy > CANCEL_AT
          if (next !== armedRef.current) {
            armedRef.current = next
            setArmed(next)
          }
        }}
        onPointerUp={() => {
          if (!pressing.current) {
            return
          }
          pressing.current = false
          const canceled = armedRef.current
          armedRef.current = false
          setArmed(false)
          onFinish(canceled)
        }}
        onPointerCancel={() => {
          if (!pressing.current) {
            return
          }
          pressing.current = false
          armedRef.current = false
          setArmed(false)
          onFinish(true)
        }}
      >
        <span className={styles.text}>{label}</span>
        {recording ? <span className={styles.timer}>{seconds}s</span> : null}
      </button>
      <div className={styles.hint}>
        {recording
          ? armed
            ? t('voiceReleaseToCancelHint')
            : t('voiceSlideUpHint')
          : t('voiceHoldHint')}
      </div>
    </div>
  )
}
