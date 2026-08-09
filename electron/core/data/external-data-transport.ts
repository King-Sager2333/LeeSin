import { session, type Session } from 'electron'
import type { DataProxyMode, DataProxyTestResult } from '../../../shared/types'
import type { ExternalDataSource } from './aram-mayhem-client'

const DATA_SOURCE_TEST_URL = 'https://aramgg.com/data/champions-stats.json'
const DATA_SOURCE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LeeSin/1.0'
const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:'])

interface VersionedChampionRow {
  championId?: string
  version?: string
  date?: string
}

export function normalizeDataProxyUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('请输入代理地址')

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('代理地址格式无效')
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('仅支持 HTTP、HTTPS、SOCKS4 和 SOCKS5 代理')
  }
  if (!parsed.hostname) throw new Error('代理地址缺少主机名')
  if (parsed.username || parsed.password) {
    throw new Error('当前仅支持无需账号密码的代理')
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('代理地址不能包含路径、查询参数或片段')
  }

  return `${parsed.protocol}//${parsed.host}`
}

function publicPatchVersion(version?: string, date?: string): string | undefined {
  if (!version) return undefined
  const match = version.match(/^(\d{2})\.(\d+)$/)
  const year = date?.match(/^(\d{4})-/)?.[1]
  if (!match || !year) return version

  const expectedMajor = Number(year.slice(-2))
  return Number(match[1]) === expectedMajor - 10
    ? `${expectedMajor}.${match[2]}`
    : version
}

export class ElectronExternalDataTransport implements ExternalDataSource {
  private readonly networkSession: Session
  private readonly rendererSession: Session | null
  private configuration: Promise<void>

  constructor(
    mode: DataProxyMode = 'system',
    proxyUrl: string = '',
    partition: string = 'leesin-external-data',
    cache: boolean = true,
    applyToRenderer: boolean = true
  ) {
    this.networkSession = session.fromPartition(partition, { cache })
    this.rendererSession = applyToRenderer ? session.defaultSession : null
    this.networkSession.setUserAgent(DATA_SOURCE_USER_AGENT, 'zh-CN,zh;q=0.9,en;q=0.7')
    this.configuration = this.applyProxy(mode, proxyUrl)
  }

  async configure(mode: DataProxyMode, proxyUrl: string): Promise<void> {
    const previous = this.configuration.catch(() => undefined)
    const next = previous.then(() => this.applyProxy(mode, proxyUrl))
    this.configuration = next
    await next
  }

  async getText(url: string): Promise<string> {
    return this.requestText(url)
  }

  async getJson<T>(url: string): Promise<T> {
    const text = await this.requestText(url)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`${new URL(url).hostname} 返回了无效的 JSON 数据`)
    }
  }

  async resolveRoute(url: string): Promise<'direct' | 'proxy'> {
    await this.configuration
    const result = await this.networkSession.resolveProxy(url)
    return result.trim().toUpperCase() === 'DIRECT' ? 'direct' : 'proxy'
  }

  static async test(
    mode: DataProxyMode,
    proxyUrl: string
  ): Promise<DataProxyTestResult> {
    const startedAt = Date.now()
    try {
      const transport = new ElectronExternalDataTransport(
        mode,
        proxyUrl,
        'leesin-external-data-proxy-test',
        false,
        false
      )
      const rows = await transport.getJson<VersionedChampionRow[]>(DATA_SOURCE_TEST_URL)
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('数据源未返回英雄数据')
      }

      const first = rows[0]
      const route = await transport.resolveRoute(DATA_SOURCE_TEST_URL)
      return {
        success: true,
        message: `连接成功（${route === 'proxy' ? '代理' : '直连'}）`,
        latencyMs: Date.now() - startedAt,
        route,
        version: publicPatchVersion(first.version, first.date),
        championCount: rows.filter(row => Number(row.championId) > 0).length,
      }
    } catch (error: any) {
      return {
        success: false,
        message: error?.name === 'AbortError'
          ? '连接超时，请检查代理是否已启动'
          : error?.message || '连接失败',
        latencyMs: Date.now() - startedAt,
      }
    }
  }

  private async applyProxy(mode: DataProxyMode, proxyUrl: string): Promise<void> {
    const targets = this.rendererSession && this.rendererSession !== this.networkSession
      ? [this.networkSession, this.rendererSession]
      : [this.networkSession]
    const normalized = mode === 'manual' ? normalizeDataProxyUrl(proxyUrl) : ''

    await Promise.all(targets.map(async target => {
      if (mode === 'manual') {
        await target.setProxy({
          mode: 'fixed_servers',
          // Chromium will try the configured proxy first, then fall back to direct.
          proxyRules: `${normalized},direct://`,
          proxyBypassRules: '<local>',
        })
      } else {
        await target.setProxy({ mode })
      }
      await target.closeAllConnections()
    }))
  }

  private async requestText(url: string): Promise<string> {
    await this.configuration
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await this.networkSession.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
      })
      if (!response.ok) {
        throw new Error(`${new URL(url).hostname} 请求失败（HTTP ${response.status}）`)
      }
      return response.text()
    } finally {
      clearTimeout(timeout)
    }
  }
}
