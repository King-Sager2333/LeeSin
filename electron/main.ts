import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { LCUConnector } from './core/lcu/connector'
import { LCUClient } from './core/lcu/client'
import { LCUWebSocket } from './core/lcu/websocket'
import { GameFlowMonitor } from './core/gameflow/monitor'
import { ConfigService } from './services/config'
import { Logger } from './services/logger'
import { registerIPCHandlers } from './ipc/handlers'
import { OPGGClient } from './core/data/opgg-client'
import { StaticDataManager } from './core/data/static-data'
import type { LCUCredentials } from '../shared/types'

// 单例
let mainWindow: BrowserWindow | null = null
let lcuConnector: LCUConnector | null = null
let lcuClient: LCUClient | null = null
let lcuWebSocket: LCUWebSocket | null = null
let gameFlowMonitor: GameFlowMonitor | null = null
let configService: ConfigService | null = null
let opggClient: OPGGClient | null = null
let staticDataManager: StaticDataManager | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 840,
    height: 910,
    minWidth: 840,
    minHeight: 710,
    frame: false,
    transparent: false,
    backgroundColor: '#010A13',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    show: false,
  })

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 开发环境加载本地服务器，生产环境加载打包文件
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

async function handleLCUConnected(credentials: LCUCredentials): Promise<void> {
  Logger.info(`LCU connected: port=${credentials.port}`)

  const client = new LCUClient(credentials.port, credentials.token)
  lcuClient = client

  // 连接状态不能被静态数据或WebSocket初始化阻塞。
  // 这些附加服务中的任意一个失败时，基础LCU API仍然可用。
  try {
    const summoner = await client.getCurrentSummoner()
    if (lcuClient !== client) return
    mainWindow?.webContents.send('lcu:connected', { port: credentials.port, summoner })
  } catch (error) {
    Logger.warn('Connected to LCU, but failed to get summoner info', error)
    if (lcuClient !== client) return
    mainWindow?.webContents.send('lcu:connected', { port: credentials.port, summoner: null })
  }

  const dataManager = new StaticDataManager(client)
  staticDataManager = dataManager
  try {
    await dataManager.initialize()
  } catch (error) {
    Logger.warn('Static data initialization failed; continuing with LCU connection', error)
  }
  if (lcuClient !== client) return

  const webSocket = new LCUWebSocket(credentials.port, credentials.token)
  lcuWebSocket = webSocket
  webSocket.on('error', (error) => {
    Logger.warn('LCU WebSocket reported an error', error)
  })

  const monitor = new GameFlowMonitor(
    client,
    webSocket,
    configService!,
    opggClient!,
    dataManager
  )
  gameFlowMonitor = monitor
  monitor.start()

  try {
    await webSocket.connect()
  } catch (error) {
    Logger.warn('LCU WebSocket connection failed; HTTP connection remains available', error)
  }
}

async function initializeServices() {
  Logger.info('Initializing services...')

  // 配置服务
  configService = new ConfigService()
  
  // OP.GG客户端
  const initialSettings = configService.getSettings()
  opggClient = new OPGGClient(
    initialSettings.dataProxyMode || 'system',
    initialSettings.dataProxyUrl || ''
  )

  // LCU连接器
  lcuConnector = new LCUConnector()
  
  // 监听LCU连接事件
  lcuConnector.on('connected', (credentials: LCUCredentials) => {
    void handleLCUConnected(credentials).catch((error) => {
      Logger.error('Failed to initialize LCU services', error)
    })
  })
  
  lcuConnector.on('disconnected', () => {
    Logger.info('LCU disconnected')
    
    // 清理资源
    lcuWebSocket?.disconnect()
    gameFlowMonitor?.stop()
    lcuWebSocket = null
    lcuClient = null
    gameFlowMonitor = null
    staticDataManager = null
    
    mainWindow?.webContents.send('lcu:disconnected')
  })
  
  lcuConnector.on('error', (error) => {
    Logger.error('LCU connection error', error)
    mainWindow?.webContents.send('lcu:error', { message: error.message })
  })
  
  // 启动LCU检测
  lcuConnector.start()
}

// 注册IPC处理器
function setupIPC() {
  registerIPCHandlers({
    getMainWindow: () => mainWindow,
    getLCUClient: () => lcuClient,
    getLCUWebSocket: () => lcuWebSocket,
    getGameFlowMonitor: () => gameFlowMonitor,
    getConfigService: () => configService,
    getOPGGClient: () => opggClient,
    getStaticDataManager: () => staticDataManager,
  })
  
  // 窗口控制
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow?.close())
}

// 应用启动
app.whenReady().then(async () => {
  createWindow()
  setupIPC()
  await initializeServices()
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 退出清理
app.on('window-all-closed', () => {
  lcuConnector?.stop()
  lcuWebSocket?.disconnect()
  gameFlowMonitor?.stop()
  
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 防止多实例
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
