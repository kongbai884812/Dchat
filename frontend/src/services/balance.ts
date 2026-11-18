import { API_ORIGIN } from './api/client.js'

/** 单个币种的余额；接口返回的都是字符串，保留原始精度 */
export type BalanceInfo = {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

export type BalanceSnapshot = {
  /** 余额是否足够调用 API */
  available: boolean
  infos: BalanceInfo[]
}

type BalanceResponse = {
  is_available?: boolean
  balance_infos?: {
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }[]
}

/** GET /user/balance，与对话请求同一个 origin，直接带用户自己的 Key */
export const fetchBalance = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<BalanceSnapshot> => {
  const response = await fetch(`${API_ORIGIN}/user/balance`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`balance request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as BalanceResponse
  const infos = (body.balance_infos ?? []).map((item) => ({
    currency: item.currency ?? '',
    total: item.total_balance ?? '0.00',
    granted: item.granted_balance ?? '0.00',
    toppedUp: item.topped_up_balance ?? '0.00',
  }))
  return { available: body.is_available !== false, infos }
}

/** 余额低于该值时提示，单位与币种无关（CNY / USD 通用） */
export const LOW_BALANCE_THRESHOLD = 1

export const isLowBalance = (info: BalanceInfo): boolean => {
  const value = Number.parseFloat(info.total)
  return Number.isFinite(value) && value < LOW_BALANCE_THRESHOLD
}

export const currencySymbol = (currency: string): string => {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥'
    case 'USD':
      return '$'
    default:
      return `${currency} `
  }
}
