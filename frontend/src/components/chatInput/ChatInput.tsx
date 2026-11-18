import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconGlobeLanguageOutline14,
  IconMicOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { HoldToTalk } from './HoldToTalk.js'
import { usePushToTalk } from './usePushToTalk.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
/** 语音模式跨页面保留：欢迎页发出第一条消息后会挂载会话页的输入框 */
let voiceModeMemory = false

export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 附件面板：在卡片内部展开，把输入区和聊天内容一起顶上去 */
  const [attachOpen, setAttachOpen] = useState(false)

  // camera.js 选完图、拍完照会回调这两个钩子收起或保留面板
  useEffect(() => {
    const host = window as unknown as Record<string, unknown>
    host.__openAttachPanel = () => setAttachOpen(true)
    host.__closeAttachPanel = () => setAttachOpen(false)
    return () => {
      delete host.__openAttachPanel
      delete host.__closeAttachPanel
    }
  }, [])

  const pickAttach = (act: 'camera' | 'gallery' | 'file') => {
    if (!ensureApiKey()) {
      return
    }
    setAttachOpen(false)
    const pick = (window as unknown as { __dchatPick?: (a: string) => void }).__dchatPick
    if (pick) {
      pick(act)
      return
    }
    // camera.js 没加载时的兜底：直接开文件选择
    fileInputRef.current?.click()
  }

  /** 语音模式：输入框换成「按住说话」，麦克风图标换成键盘图标 */
  const [voiceMode, setVoiceModeState] = useState(voiceModeMemory)
  const setVoiceMode = useCallback((value: boolean) => {
    voiceModeMemory = value
    setVoiceModeState(value)
  }, [])
  /** 松手识别完直接发送，和官方 App 一致；send 每次渲染都会重新赋值 */
  const sendRef = useRef<(force?: boolean) => void>(() => {})
  /** 拍照预览页借用同一个录音引擎时，识别结果先交给它（填进预览页输入框） */
  const voiceSinkRef = useRef<((transcript: string) => void) | null>(null)
  const voice = usePushToTalk((transcript) => {
    const sink = voiceSinkRef.current
    if (sink) {
      sink(transcript)
      return
    }
    const current = getDraft(sessionId).text
    setText(current ? `${current} ${transcript}` : transcript)
    // 语音模式下松手即发：跳过“语音状态必须空闲”的判断，但其余校验照旧
    requestAnimationFrame(() => sendRef.current(true))
  })

  // 预览页（camera.js）通过这几个钩子复用录音：开始、结束、识别结果、当前状态
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  useEffect(() => {
    const host = window as unknown as Record<string, unknown>
    host.__voiceStart = () => void voiceRef.current.start()
    host.__voiceFinish = (canceled: boolean) => void voiceRef.current.finish(canceled)
    host.__voiceStatus = () => voiceRef.current.status
    host.__voiceCancel = () => voiceRef.current.cancel()
    host.__voiceWarm = () => voiceRef.current.warm()
    host.__voiceRelease = () => voiceRef.current.release()
    host.__voiceSetSink = (sink: ((transcript: string) => void) | null) => {
      voiceSinkRef.current = sink
    }
    return () => {
      delete host.__voiceStart
      delete host.__voiceFinish
      delete host.__voiceStatus
      delete host.__voiceCancel
      delete host.__voiceWarm
      delete host.__voiceRelease
      delete host.__voiceSetSink
      voiceSinkRef.current = null
    }
  }, [])

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  /** 有文字或附件时右下角显示发送箭头，否则显示麦克风 */
  const hasContent = text.trim().length > 0 || attachments.length > 0

  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = (force = false) => {
    if (
      useChatStore.getState().importingHistory ||
      (!force && voice.status !== 'idle') ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  // 转写完成后的自动发送要拿到最新这次渲染的 send
  useEffect(() => {
    sendRef.current = send
  })

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        {voiceMode ? (
          <HoldToTalk
            status={voice.status}
            seconds={voice.seconds}
            onStart={() => void voice.start()}
            onFinish={(canceled) => void voice.finish(canceled)}
          />
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder={t('chatInputPlaceholderChat')}
              rows={2}
              // 移动端不自动聚焦，避免一打开就弹出键盘
              autoFocus={!isMobile}
              onFocus={() => setAttachOpen(false)}
              disabled={importingHistory}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onMouseDown={(event) => {
                // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
                if (
                  isMobile &&
                  event.button === 0 &&
                  document.activeElement !== event.currentTarget
                ) {
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  send()
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length > 0) {
                  event.preventDefault()
                  acceptFiles(files)
                }
              }}
            />
            <div className={styles.mirror} aria-hidden>
              {`${text}\n`}
            </div>
          </>
        )}
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={t('deactivatedThinkTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          <Tooltip content={t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          {/* 附件入口：点开后面板在卡片内展开，加号旋转成叉 */}
          <button
            type="button"
            className={styles.iconCircle}
            aria-label={attachOpen ? t('close') : t('uploadFile')}
            aria-expanded={attachOpen}
            disabled={importingHistory}
            onClick={() => {
              if (!attachOpen && !ensureApiKey()) {
                return
              }
              textareaRef.current?.blur()
              setAttachOpen(!attachOpen)
            }}
          >
            <span className={clsx(styles.plusIcon, attachOpen && styles.plusIconOpen)}>
              <PlusIcon />
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {/* 右下角一个按钮：有文字是发送、没文字是麦克风、语音模式是键盘 */}
          {voiceMode ? (
            <button
              type="button"
              className={styles.iconCircle}
              aria-label={t('voiceKeyboard')}
              disabled={voice.status === 'transcribing'}
              onClick={() => {
                voice.cancel()
                voice.release()
                setVoiceMode(false)
                requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
              }}
            >
              <KeyboardIcon />
            </button>
          ) : streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : hasContent ? (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={() => send()}
            >
              <IconSendOutline16 />
            </button>
          ) : (
            <button
              type="button"
              className={styles.iconCircle}
              aria-label={t('voiceInput')}
              disabled={importingHistory}
              onClick={() => {
                if (!voice.available) {
                  showToast({ key: 'voiceInputRequiresHttps' })
                  return
                }
                if (!ensureApiKey()) {
                  return
                }
                textareaRef.current?.blur()
                voice.warm()
                setVoiceMode(true)
              }}
            >
              <IconMicOutline16 />
            </button>
          )}
        </div>
      </div>
      <div className={clsx(styles.attachPanel, attachOpen && styles.attachPanelOpen)}>
        <button type="button" className={styles.attachItem} onClick={() => pickAttach('camera')}>
          <CameraIcon />
          <span>{t('attachCamera')}</span>
        </button>
        <button type="button" className={styles.attachItem} onClick={() => pickAttach('gallery')}>
          <AlbumIcon />
          <span>{t('attachGallery')}</span>
        </button>
        <button type="button" className={styles.attachItem} onClick={() => pickAttach('file')}>
          <FileIcon />
          <span>{t('attachFile')}</span>
        </button>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}

/** 附件面板的三个图标 */
const CameraIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 8h3l1.4-2h7.2L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>
)

const AlbumIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.4" />
    <path d="M4 17l5-5 4 4 3-3 4 4" />
  </svg>
)

const FileIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 11.5 12 19.5a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3" />
  </svg>
)

/** 附件入口的加号 */
const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
)

/** 语音模式下把麦克风换成键盘图标 */
const KeyboardIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9.5 14h5" />
    <path d="M3 21h18" opacity=".35" />
  </svg>
)
