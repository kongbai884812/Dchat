/**
 * 录音并编码为 ASR 接受的 WAV（单声道、16-bit PCM、16kHz）。
 *
 * AudioContext 以 16kHz 创建，浏览器负责重采样；ScriptProcessorNode 采集 PCM 样本。
 * 录音处理在页面内完成。
 */
import { trace } from './trace.js'

export const SAMPLE_RATE = 16000
/** ASR 单次时长上限 120 秒 */
export const MAX_SECONDS = 120

const BUFFER_SIZE = 4096

export type Recording = {
  /** 停止录音并返回 WAV；没有采到声音时返回 null */
  stop: () => Promise<Blob | null>
  /** 放弃录音，释放麦克风 */
  cancel: () => void
  /** 频谱分析节点，只读；采样率与录音一致 */
  analyser: AnalyserNode
}

/** 开始录音；到达时长上限时调用 onLimit，由调用方决定何时 stop */
/**
 * 打开麦克风。部分机型（尤其是国产 ROM）对回声消除/降噪这类约束敏感，
 * 带约束会直接抛 NotReadableError（"Could not start audio source"），
 * 所以按「带处理 → 默认 → 全关处理」依次退让，最后仍失败才抛错。
 */
const MIC_CONSTRAINTS: MediaStreamConstraints[] = [
  { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } },
  { audio: true },
  { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
]

/** 记住在这台机器上能成功的那一档，下次直接用它，省掉失败重试的 1~2 秒 */
let preferredVariant = -1

/** 预热时拿到的流，松手按下时直接复用，避免二次打开麦克风 */
let warmStream: MediaStream | null = null

const openMicrophone = async (): Promise<MediaStream> => {
  const order: number[] = []
  if (preferredVariant >= 0) {
    order.push(preferredVariant)
  }
  for (let i = 0; i < MIC_CONSTRAINTS.length; i++) {
    if (i !== preferredVariant) {
      order.push(i)
    }
  }

  let lastError: unknown
  for (let n = 0; n < order.length; n++) {
    const i = order[n]
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS[i])
      preferredVariant = i
      trace(`mic-ok#${i}`)
      return stream
    } catch (error) {
      lastError = error
      const e = error as { name?: string; message?: string }
      trace(`mic-fail#${i} ${e?.name ?? '?'} ${e?.message ?? ''}`)
      // 这一档在这台机器上明显不可用，先降级再试下一档
      if (preferredVariant === i) {
        preferredVariant = -1
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  throw lastError
}

/**
 * 预热麦克风：先开一次再关掉。
 * 这台机器首次 getUserMedia 要 1~2 秒（还要试错约束档位），
 * 进入语音模式时先热一下，真正按住时才能立刻开始收音。
 */
export const primeMicrophone = async (): Promise<void> => {
  if (warmStream) {
    return
  }
  try {
    // 保持打开：每次现开要 1~2 秒，按下再开根本来不及
    warmStream = await openMicrophone()
  } catch {
    // 预热失败不影响后续按下时的正常重试
  }
}

/** 退出语音模式时把预热流关掉，别一直占着麦克风 */
export const releaseWarmMicrophone = (): void => {
  if (!warmStream) {
    return
  }
  warmStream.getTracks().forEach((track) => track.stop())
  warmStream = null
}

export const startRecording = async (onLimit: () => void): Promise<Recording> => {
  // 预热过就直接用，没预热才现开
  const stream = warmStream ?? (await openMicrophone())
  warmStream = null
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }
    released = true
    if (processor) {
      processor.onaudioprocess = null
    }
    // 初始化可能只完成了一部分；单个节点断开失败也不能阻止麦克风释放。
    for (const node of [processor, analyser, source]) {
      try {
        node?.disconnect()
      } catch {
        // 继续释放其余资源。
      }
    }
    for (const track of stream.getTracks()) {
      track.stop()
    }
    void context?.close().catch(() => {})
  }

  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE })
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    // 频谱分析用：串在录音链路中间（原样透传），WebKit 不会处理未连到输出的分析节点
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    const chunks: Float32Array[] = []
    let length = 0
    let limited = false
    processor.onaudioprocess = (event) => {
      if (limited) {
        return
      }
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      length += BUFFER_SIZE
      if (length >= MAX_SECONDS * SAMPLE_RATE) {
        limited = true
        onLimit()
      }
    }
    source.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 只有连到输出才会持续回调；输出缓冲保持静音
    processor.connect(context.destination)
    // 在 await getUserMedia 之后创建，iOS 上可能处于 suspended
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }

    return {
      stop: async () => {
        release()
        return length === 0 ? null : encodeWav(chunks, length)
      },
      cancel: release,
      analyser,
    }
  } catch (error) {
    release()
    throw error
  }
}

const encodeWav = (chunks: Float32Array[], length: number) => {
  const samples = Math.min(length, MAX_SECONDS * SAMPLE_RATE)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  let written = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && written < samples; i++, written++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
