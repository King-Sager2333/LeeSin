import { load } from 'cheerio/slim'
import { Logger } from '../../services/logger'
import type {
  CachedChampionBuild,
  OPGGChampionTier,
  OPGGTierListResponse,
} from '../../../shared/types/opgg'

const ARAMGG_BASE_URL = 'https://aramgg.com'
const ARAM_MAYHEM_BASE_URL = 'https://arammayhem.com'
const CHAMPION_SUMMARY_URL =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json'

const BOOT_ITEM_IDS = new Set([
  1001, 2422, 3006, 3009, 3020, 3047, 3111, 3117, 3158,
])

interface AramGGTierRow {
  championId: string
  tier: string
  winRate: number
  pickRate: number
  version: string
  date: string
  rank: number
}

interface AramGGShareConfig {
  stats?: {
    tier?: string
    winRate?: number
    pickRate?: number
    version?: string
  }
}

interface ChampionSummaryRow {
  id: number
  alias: string
}

interface JsonLdEntry {
  '@type'?: string
  '@graph'?: JsonLdEntry[]
  dateModified?: string
  description?: string
}

export interface ExternalDataSource {
  getText(url: string): Promise<string>
  getJson<T>(url: string): Promise<T>
}

class FetchExternalDataSource implements ExternalDataSource {
  async getText(url: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LeeSin/1.0',
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8',
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    } finally {
      clearTimeout(timeout)
    }
  }

  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.getText(url)) as T
  }
}

function parsePercentage(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`${label}\\s*:\\s*([\\d.]+)%`, 'i'))
  if (!match) return undefined

  const value = Number(match[1])
  return Number.isFinite(value) ? value / 100 : undefined
}

function parseItemIds(html: string): number[] {
  const $ = load(html)
  return $('img')
    .map((_, image) => {
      const src = $(image).attr('src') || ''
      const match = src.match(/\/(?:item-icons|items)\/(\d+)\.png(?:[?#]|$)/i)
      return match ? Number(match[1]) : null
    })
    .get()
    .filter((id): id is number => Number.isInteger(id) && id > 0)
}

function getJsonLdEntries(html: string): JsonLdEntry[] {
  const $ = load(html)
  const entries: JsonLdEntry[] = []

  $('script[type="application/ld+json"]').each((_, script) => {
    try {
      const value = JSON.parse($(script).html() || '') as JsonLdEntry
      entries.push(value)
      if (Array.isArray(value['@graph'])) {
        entries.push(...value['@graph'])
      }
    } catch {
      // A malformed optional metadata block must not hide otherwise valid build data.
    }
  })

  return entries
}

function getDateModified(html: string): string | undefined {
  return getJsonLdEntries(html).find(entry => entry.dateModified)?.dateModified
}

function normalizePatchVersion(version: string, date?: string): string {
  const match = version.match(/^(\d{2})\.(\d+)$/)
  const year = date?.match(/^(\d{4})-/)?.[1]
  if (!match || !year) return version

  const expectedMajor = Number(year.slice(-2))
  const sourceMajor = Number(match[1])
  // Tencent's source uses season 16 while public patch labels use 26.x.
  if (sourceMajor === expectedMajor - 10) {
    return `${expectedMajor}.${match[2]}`
  }

  return version
}

function sourceDetails(version?: string, updatedAt?: string, suffix?: string): string {
  return [version ? `版本 ${version}` : '', updatedAt ? `更新于 ${updatedAt}` : '', suffix || '']
    .filter(Boolean)
    .join(' · ')
}

export function parseAramGGChampionPage(
  html: string,
  championId: number
): CachedChampionBuild | null {
  const $ = load(html)
  const buildRoot = $('[data-champion-builds]').first()
  const panel = buildRoot.find('[data-build-panel="0"]').first()
  if (!buildRoot.length) return null
  const buildScope = panel.length ? panel : buildRoot

  let shareConfig: AramGGShareConfig = {}
  try {
    shareConfig = JSON.parse($('script[data-share-card-config]').first().html() || '{}') as AramGGShareConfig
  } catch {
    // Build sections remain usable even when the optional share-card payload changes.
  }

  const findBuildSection = (heading: string) => buildScope
    .find('h3')
    .filter((_, element) => $(element).text().replace(/\s+/g, ' ').trim().startsWith(heading))
    .first()
    .parent()

  const core: CachedChampionBuild['items']['core'] = []
  const coreSection = findBuildSection('Core Items')
  coreSection.children('div').first().children('div').each((_, row) => {
    const ids = parseItemIds($.html(row))
    if (ids.length === 0) return

    core.push({
      ids,
      pickRate: parsePercentage($(row).text(), 'Pick Rate'),
    })
  })

  const starter: CachedChampionBuild['items']['starter'] = []
  const starterSection = findBuildSection('Starting Items')
  starterSection.children('div').first().children('div').each((_, row) => {
    const ids = parseItemIds($.html(row))
    if (ids.length === 0) return

    starter.push({
      ids,
      pickRate: parsePercentage($(row).text(), 'Pick Rate'),
    })
  })

  const last: number[] = []
  const situationalSection = findBuildSection('Situational Items')
  situationalSection.find('img').each((_, image) => {
    const ids = parseItemIds($.html(image))
    if (ids[0] && !last.includes(ids[0])) last.push(ids[0])
  })

  if (core.length === 0) return null

  const bootItemIds = new Set(BOOT_ITEM_IDS)
  coreSection.find('img').each((_, image) => {
    const itemName = $(image).attr('alt') || ''
    if (!/(?:boots|greaves|treads|steelcaps|shoes|soles|crushers|advance|lucidity)/i.test(itemName)) {
      return
    }
    const id = parseItemIds($.html(image))[0]
    if (id) bootItemIds.add(id)
  })

  const bootPickRates = new Map<number, number>()
  for (const build of core) {
    for (const id of build.ids) {
      if (!bootItemIds.has(id)) continue
      bootPickRates.set(id, (bootPickRates.get(id) || 0) + (build.pickRate || 0))
    }
  }
  const boots = Array.from(bootPickRates.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([id, pickRate]) => ({ ids: [id], pickRate }))

  const recommendationGroups = $('[data-recommendation-group]')
  const spellGroup = recommendationGroups
    .filter((_, group) => $(group).find('h2').text().includes('Summoner Spells'))
    .first()
  const spells: CachedChampionBuild['spells'] = []
  spellGroup.find('article').each((_, article) => {
    const ids = $(article).find('img[src*="summoner-spell-icons"]')
      .map((__, image) => {
        const src = $(image).attr('src') || ''
        const match = src.match(/summoner-spell-icons\/(\d+)\.png/i)
        return match ? Number(match[1]) : null
      })
      .get()
      .filter((id): id is number => Number.isInteger(id) && id > 0)

    if (ids.length >= 2) {
      spells.push({
        ids: ids.slice(0, 2),
        pickRate: parsePercentage($(article).text(), 'Pick Rate'),
      })
    }
  })

  const skillGroup = recommendationGroups
    .filter((_, group) => $(group).find('h2').text().includes('Skill Order'))
    .first()
  const primarySkillArticle = skillGroup.find('article').first()
  const skillText = primarySkillArticle.find('strong').first().text().toUpperCase()
  const skillPriority: string[] = skillText.match(/\b[QWE]\b/g) || []
  if (skillPriority.length > 0) {
    for (const skill of ['Q', 'W', 'E']) {
      if (!skillPriority.includes(skill)) skillPriority.push(skill)
    }
  }

  const augmentRarity: Record<string, string> = {
    '0': 'kSilver',
    '1': 'kGold',
    '2': 'kPrismatic',
  }
  const augments: NonNullable<CachedChampionBuild['augments']> = []
  $('[data-champion-augments] tr[data-row]').slice(0, 24).each((_, row) => {
    const link = $(row).find('a[href*="/augments/"]').first()
    const idMatch = (link.attr('href') || '').match(/\/augments\/(\d+)/)
    const id = idMatch ? Number(idMatch[1]) : 0
    if (!id) return

    augments.push({
      id,
      name: $(row).find('img').first().attr('alt') || link.text().trim(),
      iconUrl: $(row).find('img').first().attr('src') || '',
      rarity: augmentRarity[$(row).attr('data-rarity') || ''] || 'kSilver',
      pickRate: Number($(row).attr('data-pick-rate')) || 0,
      averagePlace: 0,
    })
  })

  const stats = shareConfig.stats || {}
  const version = stats.version || $('title').text().match(/(?:Patch\s*)?(\d+\.\d+)/i)?.[1] || ''
  const updatedAt = getDateModified(html)

  return {
    championId,
    position: 'none',
    mode: 'aram-mayhem',
    version,
    timestamp: Date.now(),
    dataSource: {
      kind: 'native',
      label: 'ARAMGG 国服海克斯大乱斗',
      details: sourceDetails(version, updatedAt, '国服公开对局统计'),
    },
    summary: {
      winRate: Number(stats.winRate) || 0,
      pickRate: Number(stats.pickRate) || 0,
      tier: Number(stats.tier) || undefined,
    },
    runes: [],
    spells: spells.slice(0, 3),
    skills: {
      masteries: skillPriority,
      order: [],
      pickRate: parsePercentage(primarySkillArticle.text(), 'Pick Rate'),
    },
    items: {
      starter: starter.slice(0, 3),
      core: core.slice(0, 5),
      boots: boots.slice(0, 3),
      last: last.slice(0, 16),
    },
    augments,
  }
}

export function parseAramMayhemChampionPage(
  html: string,
  championId: number
): CachedChampionBuild | null {
  const $ = load(html)
  const findItemSection = (heading: string) => $('section')
    .filter((_, section) => {
      const firstChildText = $(section).children().first().text().replace(/\s+/g, ' ').trim()
      return firstChildText === heading && $(section).find('img[src*="/items/"]').length > 0
    })
    .first()

  const core: CachedChampionBuild['items']['core'] = []
  const coreSection = findItemSection('Core Builds')
  coreSection.children().eq(1).children().each((_, row) => {
    const ids = parseItemIds($.html(row))
    if (ids.length === 0) return
    core.push({ ids, pickRate: parsePercentage($(row).text(), 'Pick Rate') })
  })
  if (core.length === 0) return null

  const boots: CachedChampionBuild['items']['boots'] = []
  const bootsSection = findItemSection('Boots')
  bootsSection.children().eq(1).children().each((_, row) => {
    const ids = parseItemIds($.html(row))
    if (ids.length === 0) return
    boots.push({ ids: [ids[0]], pickRate: parsePercentage($(row).text(), 'Pick Rate') })
  })

  const last: number[] = []
  const firstItemsSection = findItemSection('Starting Items')
  firstItemsSection.find('img[src*="/items/"]').each((_, image) => {
    const ids = parseItemIds($.html(image))
    if (ids[0] && !last.includes(ids[0])) last.push(ids[0])
  })

  const article = getJsonLdEntries(html).find(entry => entry['@type'] === 'Article')
  const description = article?.description || ''
  const version = description.match(/Patch\s+(\d+\.\d+)/i)?.[1]
    || $('title').text().match(/\((\d+\.\d+)\)/)?.[1]
    || ''
  const winRate = Number(description.match(/([\d.]+)%\s+win rate/i)?.[1] || 0) / 100
  const updatedAt = article?.dateModified || getDateModified(html)

  return {
    championId,
    position: 'none',
    mode: 'aram-mayhem',
    version,
    timestamp: Date.now(),
    dataSource: {
      kind: 'native',
      label: 'ARAM Mayhem 专属备用数据',
      details: sourceDetails(version, updatedAt, '主数据源不可用时自动切换'),
    },
    summary: {
      winRate: Number.isFinite(winRate) ? winRate : 0,
      pickRate: 0,
    },
    runes: [],
    spells: [],
    skills: {
      masteries: [],
      order: [],
    },
    items: {
      starter: [],
      core: core.slice(0, 5),
      boots: boots.slice(0, 3),
      last: last.slice(0, 16),
    },
    augments: [],
  }
}

export class AramMayhemClient {
  private externalData: ExternalDataSource
  private championAliases: Map<number, string> | null = null
  private championAliasesPromise: Promise<Map<number, string>> | null = null

  constructor(externalData: ExternalDataSource = new FetchExternalDataSource()) {
    this.externalData = externalData
  }

  async getTierList(): Promise<OPGGTierListResponse | null> {
    try {
      const response = await this.externalData.getJson<AramGGTierRow[]>(
        `${ARAMGG_BASE_URL}/data/champions-stats.json`
      )
      const rows = Array.isArray(response) ? response : []
      if (rows.length === 0) return null

      const dates = rows.map(row => row.date).filter(Boolean).sort()
      const latestDate = dates[dates.length - 1]
      const version = normalizePatchVersion(rows[0]?.version || '', latestDate)
      const data: OPGGChampionTier[] = rows
        .map(row => ({
          id: Number(row.championId),
          is_rotation: false,
          average_stats: {
            win_rate: Number(row.winRate) || 0,
            pick_rate: Number(row.pickRate) || 0,
            ban_rate: 0,
            kda: 0,
            tier: Number(row.tier) || 0,
            rank: Number(row.rank) || 0,
          },
        }))
        .filter(row => Number.isInteger(row.id) && row.id > 0 && (row.average_stats?.win_rate || 0) > 0)

      if (data.length === 0) return null

      return {
        meta: {
          version,
          dataSource: {
            kind: 'native',
            label: 'ARAMGG 国服海克斯大乱斗',
            details: sourceDetails(version, latestDate, '国服公开对局统计'),
          },
        },
        data,
      }
    } catch (error: any) {
      Logger.warn('Failed to get ARAMGG ARAM Mayhem tier list', error.message)
      return null
    }
  }

  async getChampionBuild(championId: number): Promise<CachedChampionBuild | null> {
    try {
      const response = await this.externalData.getText(
        `${ARAMGG_BASE_URL}/en/champion-stats/${championId}`
      )
      const build = parseAramGGChampionPage(response, championId)
      if (build) return build
      throw new Error('ARAMGG page did not contain a usable build')
    } catch (error: any) {
      Logger.warn(`ARAMGG build unavailable for champion ${championId}; trying dedicated fallback`, error.message)
    }

    try {
      const alias = await this.getChampionAlias(championId)
      if (!alias) return null

      const response = await this.externalData.getText(
        `${ARAM_MAYHEM_BASE_URL}/build/${encodeURIComponent(alias.toLowerCase())}/`
      )
      return parseAramMayhemChampionPage(response, championId)
    } catch (error: any) {
      Logger.error(`Dedicated ARAM Mayhem build sources failed for champion ${championId}`, error.message)
      return null
    }
  }

  private async getChampionAlias(championId: number): Promise<string | undefined> {
    if (!this.championAliasesPromise) {
      this.championAliasesPromise = this.loadChampionAliases()
    }
    const aliases = await this.championAliasesPromise
    return aliases.get(championId)
  }

  private async loadChampionAliases(): Promise<Map<number, string>> {
    if (this.championAliases) return this.championAliases

    const response = await this.externalData.getJson<ChampionSummaryRow[]>(CHAMPION_SUMMARY_URL)
    const aliases = new Map<number, string>()
    for (const champion of response) {
      if (champion.id > 0 && champion.alias) aliases.set(champion.id, champion.alias)
    }
    this.championAliases = aliases
    return aliases
  }
}
