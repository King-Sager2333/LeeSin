import { useEffect } from 'react'
import { useLCUStore, useGameFlowStore, useChampSelectStore, useSettingsStore, useDataStore, useNotificationStore } from '../store'
import type { Summoner, GameFlowPhase, ChampSelectSession, AppSettings, GameModeContext } from '../../shared/types'

export function useLCU() {
  const { connected, summoner, setConnected } = useLCUStore()
  const { setPhase, setGameMode } = useGameFlowStore()
  const { setSession, setTimer } = useChampSelectStore()
  const { setSettings } = useSettingsStore()
  const { setChampions } = useDataStore()
  const { addNotification } = useNotificationStore()
  
  useEffect(() => {
    // 获取初始状态
    const initializeState = async () => {
      try {
        // 获取LCU状态
        const status = await window.electronAPI.lcu.getStatus()
        setConnected(status.connected, status.summoner)
        
        if (status.connected) {
          // 获取游戏流状态
          const phase = await window.electronAPI.gameflow.getPhase()
          setPhase(phase)

          const modeContext = await window.electronAPI.gameflow.getMode()
          setGameMode(modeContext.mode, modeContext.queueId)

          if (phase === 'ChampSelect') {
            const session = await window.electronAPI.champSelect.getSession()
            setSession(session)
          }
          
          // 获取设置
          const settings = await window.electronAPI.settings.get()
          if (settings) setSettings(settings)
          
          // 获取英雄数据
          const champions = await window.electronAPI.data.getChampions()
          setChampions(champions)
        }
      } catch (error) {
        console.error('初始化状态失败', error)
      }
    }
    
    initializeState()
    
    // 订阅LCU连接事件
    const unsubConnect = window.electronAPI.lcu.onConnected(async (data: { port: number; summoner: Summoner | null }) => {
      setConnected(true, data.summoner)
      addNotification('已连接到LOL客户端', 'success')
      
      // 重新获取数据
      window.electronAPI.data.getChampions().then(setChampions)
      window.electronAPI.settings.get().then((s: AppSettings | null) => s && setSettings(s))

      const [phase, modeContext] = await Promise.all([
        window.electronAPI.gameflow.getPhase(),
        window.electronAPI.gameflow.getMode(),
      ])
      setPhase(phase)
      setGameMode(modeContext.mode, modeContext.queueId)

      if (phase === 'ChampSelect') {
        setSession(await window.electronAPI.champSelect.getSession())
      }
    })
    
    const unsubDisconnect = window.electronAPI.lcu.onDisconnected(() => {
      setConnected(false)
      setPhase('None')
      setGameMode('ranked', 0)
      setSession(null)
      addNotification('与LOL客户端断开连接', 'info')
    })
    
    // 订阅游戏流事件
    const unsubPhase = window.electronAPI.gameflow.onPhaseChanged((data: { phase: GameFlowPhase }) => {
      setPhase(data.phase)
      if (data.phase !== 'ChampSelect') {
        setSession(null)
      }
    })

    const unsubMode = window.electronAPI.gameflow.onModeChanged((data: GameModeContext) => {
      setGameMode(data.mode, data.queueId)
    })
    
    // 订阅英雄选择事件
    const unsubSession = window.electronAPI.champSelect.onSessionUpdated((session: ChampSelectSession) => {
      setSession(session)
    })
    
    const unsubTimer = window.electronAPI.champSelect.onTimerTick((data: { remaining: number; phase: string }) => {
      setTimer(data)
    })
    
    // 订阅自动化事件
    const unsubAction = window.electronAPI.automation.onActionExecuted((data: { action: string; success: boolean; message?: string }) => {
      // 只显示非空消息
      if (data.message && data.message.trim() !== '') {
        addNotification(
          data.message || `${data.action} ${data.success ? '成功' : '失败'}`,
          data.success ? 'success' : 'error'
        )
      }
    })
    
    return () => {
      unsubConnect()
      unsubDisconnect()
      unsubPhase()
      unsubMode()
      unsubSession()
      unsubTimer()
      unsubAction()
    }
  }, [])
  
  return { connected, summoner }
}
