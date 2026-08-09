import { LRUCache } from 'lru-cache'
import { Logger } from '../../services/logger'
import { OPGG_API } from '../../../shared/constants'
import { AramMayhemClient } from './aram-mayhem-client'
import { ElectronExternalDataTransport } from './external-data-transport'
import type { DataProxyMode, DataProxyTestResult } from '../../../shared/types'
import type { 
  OPGGChampionBuildResponse, 
  OPGGTierListResponse, 
  CachedChampionBuild 
} from '../../../shared/types/opgg'

// 增幅符文数据缓存
interface AugmentData {
  id: number
  nameTRA: string
  augmentSmallIconPath: string
  rarity: string
}

export class OPGGClient {
  private externalData: ElectronExternalDataTransport
  private cache: LRUCache<string, any>
  private augmentsCache: Map<number, AugmentData> = new Map()
  private aramMayhemClient: AramMayhemClient
  
  constructor(proxyMode: DataProxyMode = 'system', proxyUrl: string = '') {
    this.externalData = new ElectronExternalDataTransport(proxyMode, proxyUrl)
    this.aramMayhemClient = new AramMayhemClient(this.externalData)
    
    // LRU cache, 500 entries max, 1 hour TTL
    this.cache = new LRUCache<string, any>({
      max: 500,
      ttl: 1000 * 60 * 60,
    })
    
    // 初始化增幅符文数据
    this.loadAugmentsData()
  }
  
  // 加载增幅符文数据 (使用中文版本)
  private async loadAugmentsData(): Promise<void> {
    try {
      const response = await this.externalData.getJson<AugmentData[]>(
        'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json'
      )
      
      for (const aug of response) {
        this.augmentsCache.set(aug.id, aug)
      }
      
      Logger.info(`Loaded ${this.augmentsCache.size} augments (zh_cn)`)
    } catch (error: any) {
      Logger.error('Failed to load augments data', error.message)
    }
  }
  
  // 获取增幅符文信息
  getAugmentInfo(augmentId: number): { name: string; iconUrl: string; rarity: string } | null {
    const aug = this.augmentsCache.get(augmentId)
    if (!aug) return null
    
    // 转换图标路径为CDN URL
    // 原始路径: /lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/ADAPt_small.png
    // CDN URL: https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/ux/cherry/augments/icons/adapt_small.png
    const iconPath = aug.augmentSmallIconPath
      .replace('/lol-game-data/assets/', '')
      .toLowerCase()
    
    return {
      name: aug.nameTRA,
      iconUrl: `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${iconPath}`,
      rarity: aug.rarity  // kSilver, kGold, kPrismatic
    }
  }
  
  // 确保增幅数据已加载
  async ensureAugmentsLoaded(): Promise<void> {
    if (this.augmentsCache.size === 0) {
      await this.loadAugmentsData()
    }
  }
  
  async getTierList(
    mode: string = 'ranked',
    region: string = 'kr',
    tier: string = 'emerald_plus'
  ): Promise<OPGGTierListResponse | null> {
    const cacheKey = `tierlist:${region}:${mode}:${tier}`
    
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }

    if (mode === 'aram-mayhem') {
      const nativeResult = await this.aramMayhemClient.getTierList()
      if (nativeResult) {
        this.cache.set(cacheKey, nativeResult)
        return nativeResult
      }

      Logger.warn('Dedicated ARAM Mayhem tier list unavailable; using explicitly labelled ARAM rankings')
      try {
        const fallbackUrl = OPGG_API.TIER_LIST(region, 'aram', tier)
        const fallbackResponse = await this.getOPGG<OPGGTierListResponse>(fallbackUrl)
        const fallbackResult: OPGGTierListResponse = {
          ...fallbackResponse,
          meta: {
            ...fallbackResponse.meta,
            dataSource: {
              kind: 'fallback',
              label: '普通大乱斗英雄排行',
              details: '海克斯大乱斗专属排行源暂时不可用；仅排行临时降级，英雄出装不会使用普通大乱斗数据',
            },
          },
        }
        this.cache.set(cacheKey, fallbackResult)
        return fallbackResult
      } catch (error: any) {
        Logger.error('Failed to get ARAM fallback tier list', error.message)
        return null
      }
    }
    
    try {
      const url = OPGG_API.TIER_LIST(region, mode, tier)
      const response = await this.getOPGG<OPGGTierListResponse>(url)
      
      this.cache.set(cacheKey, response)
      
      return response
    } catch (error: any) {
      Logger.error('Failed to get OP.GG tier list', error.message)
      return null
    }
  }
  
  async getChampionBuild(
    championId: number,
    position: string,
    region: string = 'kr',
    tier: string = 'emerald_plus',
    mode: string = 'ranked'
  ): Promise<CachedChampionBuild | null> {
    const cacheKey = `build:${region}:${mode}:${championId}:${position}:${tier}`
    
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }
    
    // 确保增幅数据已加载 (竞技场和符文大乱斗需要)
    if (mode === 'arena' || mode === 'aram-mayhem') {
      await this.ensureAugmentsLoaded()
    }
    
    // ARAM Mayhem uses dedicated, current-mode sources only. Ordinary ARAM and
    // Arena builds are materially different and must never be presented as Mayhem data.
    if (mode === 'aram-mayhem') {
      const dedicatedBuild = await this.aramMayhemClient.getChampionBuild(championId)
      if (!dedicatedBuild) {
        Logger.error(`No current dedicated ARAM Mayhem build is available for champion ${championId}`)
        return null
      }

      dedicatedBuild.augments = dedicatedBuild.augments?.map(augment => {
        const localInfo = this.getAugmentInfo(augment.id)
        return {
          ...augment,
          name: localInfo?.name || augment.name,
          iconUrl: localInfo?.iconUrl || augment.iconUrl,
          rarity: localInfo?.rarity || augment.rarity,
        }
      })
      this.cache.set(cacheKey, dedicatedBuild)
      return dedicatedBuild
    }
    
    try {
      // Arena mode doesn't need position
      let url: string
      if (mode === 'arena') {
        url = OPGG_API.ARENA_BUILD(region, championId, 'all')
      } else if (mode === 'aram') {
        // ARAM模式使用 'none' 作为position
        url = OPGG_API.CHAMPION_BUILD(region, mode, championId, 'none', tier)
      } else {
        url = OPGG_API.CHAMPION_BUILD(region, mode, championId, position, tier)
      }
      
      Logger.debug(`Fetching OP.GG build: ${url}`)
      const response = await this.getOPGG<OPGGChampionBuildResponse>(url)
      
      // 添加更详细的日志
      if (championId === 89) { // Leona
        Logger.debug(`Leona response data: ${JSON.stringify(response, null, 2)}`)
      }
      
      // Parse based on mode
      let build: CachedChampionBuild | null
      if (mode === 'arena') {
        build = this.parseArenaBuild(response, championId)
      } else {
        build = this.parseNormalBuild(response, championId, position)
      }
      
      if (build) {
        build.mode = mode
        build.version = response.meta?.version || ''
        this.cache.set(cacheKey, build)
      }
      
      return build
    } catch (error: any) {
      Logger.error(`Failed to get OP.GG build: ${championId}/${position}/${mode}`, error.message)
      return null
    }
  }
  
  private parseNormalBuild(
    response: OPGGChampionBuildResponse,
    championId: number,
    position: string
  ): CachedChampionBuild | null {
    const data = response.data
    if (!data) return null
    
    // Find position data
    let positionData = data.positions?.find(
      p => p.name.toLowerCase() === position.toLowerCase()
    )
    
    if (!positionData && data.positions?.length) {
      positionData = data.positions[0]
    }
    
    // Get summary stats
    let summary: any = {}
    if (positionData) {
      const stats = positionData.stats
      summary = {
        winRate: stats.win_rate,
        pickRate: stats.pick_rate,
        banRate: stats.ban_rate,
        kda: stats.kda,
        tier: stats.tier_data?.tier || stats.tier,
        rank: stats.tier_data?.rank || stats.rank,
      }
    } else if (data.summary?.average_stats) {
      const stats = data.summary.average_stats
      summary = {
        winRate: stats.win_rate,
        pickRate: stats.pick_rate,
        banRate: stats.ban_rate,
        kda: stats.kda,
        tier: stats.tier,
        rank: stats.rank,
      }
    }
    
    // Get runes
    const runesData = positionData?.runes || data.runes || []
    const runes = runesData.slice(0, 3).map(r => ({
      primaryStyleId: r.primary_page_id,
      subStyleId: r.secondary_page_id,
      selectedPerkIds: [
        ...r.primary_rune_ids,
        ...r.secondary_rune_ids,
        ...r.stat_mod_ids,
      ],
      pickRate: r.pick_rate,
    }))
    
    // Get spells
    const spellsData = positionData?.summoner_spells || data.summoner_spells || []
    const spells = spellsData.slice(0, 3).map(s => ({
      ids: s.ids,
      pickRate: s.pick_rate,
    }))
    
    // Get skills
    const skillMasteries = positionData?.skill_masteries || data.skill_masteries || []
    const skillOrders = positionData?.skills || data.skills || []
    const skills = {
      masteries: skillMasteries[0]?.ids || [],
      order: skillOrders[0]?.order || [],
      pickRate: skillOrders[0]?.pick_rate,
    }
    
    // Get items
    const starterData = positionData?.starter_items || data.starter_items || []
    const coreData = positionData?.core_items || data.core_items || []
    const bootsData = positionData?.boots || data.boots || []
    const lastData = positionData?.last_items || data.last_items || []
    
    const items = {
      starter: starterData.slice(0, 3).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      core: coreData.slice(0, 5).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      boots: bootsData.slice(0, 3).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      last: lastData.slice(0, 16).map(i => i.ids[0]),
    }
    
    // Get counters
    const countersData = positionData?.counters || data.counters || []
    const strongAgainst: any[] = []
    const weakAgainst: any[] = []
    
    for (const c of countersData) {
      const winRate = c.play > 0 ? c.win / c.play : 0.5
      const item = { championId: c.champion_id, winRate }
      
      if (winRate >= 0.5) {
        strongAgainst.push(item)
      } else {
        weakAgainst.push(item)
      }
    }
    
    strongAgainst.sort((a, b) => b.winRate - a.winRate)
    weakAgainst.sort((a, b) => a.winRate - b.winRate)
    
    return {
      championId,
      position,
      mode: 'ranked',
      version: '',
      timestamp: Date.now(),
      summary,
      runes,
      spells,
      skills,
      items,
      counters: {
        strongAgainst: strongAgainst.slice(0, 5),
        weakAgainst: weakAgainst.slice(0, 5),
      },
    }
  }
  
  private parseArenaBuild(
    response: OPGGChampionBuildResponse,
    championId: number
  ): CachedChampionBuild | null {
    const data = response.data
    if (!data) return null
    
    // Arena summary
    const avgStats = data.summary?.average_stats
    const summary = avgStats ? {
      winRate: (avgStats.play || 0) > 0 ? (avgStats.win || 0) / (avgStats.play || 1) : 0,
      pickRate: avgStats.pick_rate,
      banRate: avgStats.ban_rate,
      tier: avgStats.tier,
      averagePlace: (avgStats.play || 0) > 0 ? (avgStats.total_place || 0) / (avgStats.play || 1) : 4,
      firstRate: (avgStats.play || 0) > 0 ? (avgStats.first_place || 0) / (avgStats.play || 1) : 0,
    } : {
      winRate: 0,
      pickRate: 0,
      averagePlace: 4,
      firstRate: 0
    }
    
    // Get skills
    const skillMasteries = data.skill_masteries || []
    const skillOrders = data.skills || []
    const skills = {
      masteries: skillMasteries[0]?.ids || [],
      order: skillOrders[0]?.order || [],
      pickRate: skillOrders[0]?.pick_rate,
    }
    
    // Get items
    const starterData = data.starter_items || []
    const coreData = data.core_items || []
    const bootsData = data.boots || []
    const lastData = data.last_items || []
    
    const items = {
      starter: starterData.slice(0, 3).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      core: coreData.slice(0, 5).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      boots: bootsData.slice(0, 3).map(i => ({
        ids: i.ids,
        pickRate: i.pick_rate,
      })),
      last: lastData.slice(0, 16).map(i => i.ids[0]),
    }
    
    const augments = this.parseAugments(data)

    // Get synergies
    const synergiesData = data.synergies || []
    const synergies = synergiesData.slice(0, 10).map(s => ({
      championId: s.champion_id,
      winRate: s.play > 0 ? s.win / s.play : 0,
      averagePlace: s.play > 0 ? s.total_place / s.play : 4,
    }))

    return {
      championId,
      position: 'none',
      mode: 'arena',
      version: '',
      timestamp: Date.now(),
      summary,
      runes: [],  // Arena doesn't have runes
      spells: [],  // Arena doesn't have spells selection
      skills,
      items,
      augments,
      synergies,
    }
  }

  private parseAugments(data: OPGGChampionBuildResponse['data']): NonNullable<CachedChampionBuild['augments']> {
    const augmentGroups = data.augment_group || []
    const allAugments: any[] = []
    
    for (const group of augmentGroups) {
      for (const aug of group.augments) {
        const augInfo = this.getAugmentInfo(aug.id)
        allAugments.push({
          id: aug.id,
          name: augInfo?.name || `增幅 #${aug.id}`,
          iconUrl: augInfo?.iconUrl || '',
          rarity: augInfo?.rarity || 'kSilver',
          pickRate: aug.pick_rate,
          averagePlace: aug.play > 0 ? aug.total_place / aug.play : 4,
        })
      }
    }
    
    // 按选取率排序并去重
    const seenIds = new Set<number>()
    return allAugments
      .filter(aug => {
        if (seenIds.has(aug.id)) return false
        seenIds.add(aug.id)
        return true
      })
      .sort((a, b) => b.pickRate - a.pickRate)
  }

  async getChampionPositions(
    championId: number,
    region: string = 'kr',
    tier: string = 'emerald_plus'
  ): Promise<string[]> {
    const tierList = await this.getTierList('ranked', region, tier)
    if (!tierList?.data) return []
    
    for (const item of tierList.data) {
      if (item.id === championId && item.positions) {
        return item.positions.map(p => p.name)
      }
    }
    
    return []
  }
  
  clearCache(): void {
    this.cache.clear()
  }

  async configureDataProxy(mode: DataProxyMode, proxyUrl: string): Promise<void> {
    await this.externalData.configure(mode, proxyUrl)
    this.clearCache()
  }

  async testDataProxy(mode: DataProxyMode, proxyUrl: string): Promise<DataProxyTestResult> {
    return ElectronExternalDataTransport.test(mode, proxyUrl)
  }

  private getOPGG<T>(path: string): Promise<T> {
    return this.externalData.getJson<T>(new URL(path, OPGG_API.BASE_URL).toString())
  }
}
