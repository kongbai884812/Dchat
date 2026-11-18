declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 壳注入到 window 上的东西：诊断浮层开关、API Key 加密存储桥（浏览器里没有后者） */
interface Window {
  __openDiag?: () => void
  __closeDiag?: () => void
  DchatSecure?: {
    getKey: () => string | null
    setKey: (value: string) => void
    clearKey: () => void
  }
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
