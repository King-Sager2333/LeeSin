import { LCUClient } from '../lcu/client'
import { OPGGClient } from '../data/opgg-client'
import { ConfigService } from '../../services/config'
import { Logger } from '../../services/logger'
import { POSITION_MAP, SUMMONER_SPELL_IDS } from '../../../shared/constants'
import type { AutoActionResult } from './auto-accept'

export class AutoSpell {
  private lcuClient: LCUClient
  private opggClient: OPGGClient
  private configService: ConfigService
  private lastAppliedChampion: number = 0
  
  constructor(
    lcuClient: LCUClient, 
    opggClient: OPGGClient,
    configService: ConfigService
  ) {
    this.lcuClient = lcuClient
    this.opggClient = opggClient
    this.configService = configService
  }
  
  async execute(championId: number, position: string, gameMode: string = 'ranked'): Promise<AutoActionResult> {
    const settings = this.configService.getSettings()
    
    if (!settings.autoSpell) {
      return { executed: false, success: false, message: 'Auto-spell disabled' }
    }

    if (gameMode === 'arena') {
      return { executed: false, success: false, message: '' }
    }
    
    // 防止重复设置同一英雄
    if (championId === this.lastAppliedChampion) {
      return { executed: false, success: false, message: 'Spells already set' }
    }
    
    try {
      // 从OP.GG获取推荐技能
      const normalizedPosition = POSITION_MAP[position] || 'mid'
      const recommendationMode = ['ranked', 'aram', 'aram-mayhem'].includes(gameMode)
        ? gameMode
        : 'ranked'
      const build = await this.opggClient.getChampionBuild(
        championId, 
        normalizedPosition,
        settings.region,
        settings.tier,
        recommendationMode
      )
      
      if (!build || !build.spells || build.spells.length === 0) {
        // 无统计数据时按模式使用默认技能（大乱斗为闪现 + 雪球）。
        await this.applyDefaultSpells(position, recommendationMode)
        this.lastAppliedChampion = championId
        return { executed: true, success: true, message: '默认召唤师技能已应用，D/F 键位保持不变' }
      }
      
      // 只应用第一个推荐召唤师技能
      const firstSpell = build.spells[0]
      const [spellOnD, spellOnF] = await this.lcuClient.applySummonerSpellsPreservingSlots(
        firstSpell.ids[0],
        firstSpell.ids[1]
      )
      
      this.lastAppliedChampion = championId
      
      Logger.info(`Summoner spells set: D=${spellOnD}, F=${spellOnF}`)
      return { executed: true, success: true, message: '召唤师技能已应用，D/F 键位保持不变' }
    } catch (error: any) {
      Logger.error('Auto-spell failed', error)
      return { executed: true, success: false, message: error.message }
    }
  }
  
  private async applyDefaultSpells(position: string, gameMode: string): Promise<void> {
    const spell1 = SUMMONER_SPELL_IDS.FLASH
    let spell2: number = SUMMONER_SPELL_IDS.IGNITE

    if (gameMode === 'aram' || gameMode === 'aram-mayhem') {
      spell2 = SUMMONER_SPELL_IDS.MARK
      await this.lcuClient.applySummonerSpellsPreservingSlots(spell1, spell2)
      return
    }
    
    // 根据位置选择默认技能
    switch (position.toLowerCase()) {
      case 'jungle':
        spell2 = SUMMONER_SPELL_IDS.SMITE
        break
      case 'top':
        spell2 = SUMMONER_SPELL_IDS.TELEPORT
        break
      case 'support':
      case 'utility':
        spell2 = SUMMONER_SPELL_IDS.EXHAUST
        break
      case 'adc':
      case 'bottom':
        spell2 = SUMMONER_SPELL_IDS.HEAL
        break
    }
    
    await this.lcuClient.applySummonerSpellsPreservingSlots(spell1, spell2)
  }
  
  reset(): void {
    this.lastAppliedChampion = 0
  }
}
