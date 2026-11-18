/**
 * 语音链路诊断：把本次启动内的每一步累积写到同一个文件
 * （下载目录 dchat-voice-<session>.txt），只有在原生壳提供
 * NativeShell.dumpText 时才生效，浏览器里是空操作。
 */
const session = Date.now()
const lines: string[] = []

export const trace = (step: string) => {
  try {
    lines.push(`${new Date().toISOString().slice(11, 23)} ${step}`)
    const bridge = (
      window as unknown as { NativeShell?: { dumpText?: (n: string, t: string) => void } }
    ).NativeShell
    bridge?.dumpText?.(`dchat-voice-${session}.txt`, lines.join('\n'))
  } catch {
    // 诊断失败不影响录音
  }
}
