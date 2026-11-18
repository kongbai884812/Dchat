import type { ReactNode } from 'react'
import { IconButton } from './IconButton.js'
import { useTranslate } from '../../i18n/index.js'

/** 诊断入口的「?」图标，点击后由 public/diag.js 打开全屏诊断页 */
const DiagIcon = (): ReactNode => (
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
    <circle cx="12" cy="12" r="9.2" />
    <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.1-2.6 3.7" />
    <circle cx="12" cy="17.1" r="0.95" fill="currentColor" stroke="none" />
  </svg>
)

/** 顶栏右上角的诊断按钮：移动端顶栏、桌面端会话头、桌面端欢迎页都用它，位置恒定 */
export const DiagButton = ({
  size = 'm',
  className,
}: {
  size?: 'xs' | 'm' | 'xl'
  className?: string
}) => {
  const t = useTranslate()
  return (
    <IconButton
      size={size}
      className={className}
      icon={<DiagIcon />}
      tooltip={t('diagnostics')}
      onClick={() => window.__openDiag?.()}
    />
  )
}
