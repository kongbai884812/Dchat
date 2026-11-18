import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconRefreshOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { useSettings } from '../../services/settings.js'
import {
  currencySymbol,
  fetchBalance,
  isLowBalance,
  type BalanceSnapshot,
} from '../../services/balance.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './BalancePanel.module.css'

type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; snapshot: BalanceSnapshot }
  | { status: 'error' }

/**
 * 账户余额：设置 → 数据管理里的一块。
 * 只在打开设置时拉一次，点刷新再拉；余额请求失败不影响对话本身。
 */
export const BalancePanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [state, setState] = useState<BalanceState>({ status: 'idle' })
  const requestId = useRef(0)

  const load = useCallback(async () => {
    if (!apiKey) {
      setState({ status: 'idle' })
      return
    }
    const id = requestId.current + 1
    requestId.current = id
    setState({ status: 'loading' })
    try {
      const snapshot = await fetchBalance(apiKey)
      if (requestId.current === id) {
        setState({ status: 'ready', snapshot })
      }
    } catch {
      if (requestId.current === id) {
        setState({ status: 'error' })
      }
    }
  }, [apiKey])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>{t('balanceTitle')}</span>
        <IconButton
          icon={<IconRefreshOutline16 />}
          tooltip={t('balanceRefresh')}
          disabled={!apiKey || state.status === 'loading'}
          onClick={() => void load()}
        />
      </div>
      <BalanceBody state={state} />
    </div>
  )
}

const BalanceBody = ({ state }: { state: BalanceState }) => {
  const t = useTranslate()

  if (state.status === 'idle') {
    return <div className={styles.hint}>{t('balanceNoKey')}</div>
  }
  if (state.status === 'loading') {
    return <div className={styles.hint}>{t('balanceLoading')}</div>
  }
  if (state.status === 'error') {
    return <div className={clsx(styles.hint, styles.error)}>{t('balanceError')}</div>
  }
  if (state.snapshot.infos.length === 0) {
    return <div className={styles.hint}>{t('balanceEmpty')}</div>
  }

  return (
    <>
      <ul className={styles.list}>
        {state.snapshot.infos.map((info) => (
          <li key={info.currency} className={styles.item}>
            <span className={clsx(styles.amount, isLowBalance(info) && styles.low)}>
              {currencySymbol(info.currency)}
              {info.total}
            </span>
            <span className={styles.meta}>
              {t('balanceDetail', {
                currency: info.currency,
                granted: info.granted,
                toppedUp: info.toppedUp,
              })}
            </span>
          </li>
        ))}
      </ul>
      {state.snapshot.available ? null : (
        <div className={clsx(styles.hint, styles.error)}>{t('balanceInsufficient')}</div>
      )}
    </>
  )
}
