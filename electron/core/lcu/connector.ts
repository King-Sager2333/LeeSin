import { EventEmitter } from 'events'
import { execFile, execFileSync } from 'child_process'
import { request as httpsRequest } from 'https'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { Logger } from '../../services/logger'
import type { LCUCredentials } from '../../../shared/types'

const execFileAsync = promisify(execFile)
const LCU_HEALTH_ENDPOINTS = [
  '/riotclient/ux-state',
  '/lol-gameflow/v1/gameflow-phase',
] as const

export class LCUConnector extends EventEmitter {
  private pollingInterval: NodeJS.Timeout | null = null
  private currentCredentials: LCUCredentials | null = null
  private isConnected = false
  private isPolling = false
  private consecutiveHealthCheckFailures = 0
  private readonly POLL_INTERVAL = 2000 // 2秒轮询
  private readonly HEALTH_CHECK_TIMEOUT = 1500
  private readonly MAX_HEALTH_CHECK_FAILURES = 3
  private installPath: string | null = null
  private tasklistPath: string | null = null
  
  constructor() {
    super()
    this.findTasklistPath()
  }
  
  private findTasklistPath(): void {
    // 查找tasklist可执行文件路径
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const paths = ['tasklist.exe', join(systemRoot, 'System32', 'tasklist.exe')]
    for (const p of paths) {
      try {
        execFileSync(p, ['/?'], {
          windowsHide: true,
          timeout: 3000,
          stdio: 'ignore',
        })
        this.tasklistPath = p
        Logger.debug(`Found tasklist: ${p}`)
        break
      } catch {
        // 继续尝试下一个
      }
    }
  }
  
  start(): void {
    if (this.pollingInterval) return

    Logger.info('Starting LCU connector...')
    void this.poll()
    this.pollingInterval = setInterval(() => void this.poll(), this.POLL_INTERVAL)
  }
  
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }
    this.isConnected = false
    this.currentCredentials = null
    this.consecutiveHealthCheckFailures = 0
  }
  
  private async poll(): Promise<void> {
    if (this.isPolling) return
    this.isPolling = true

    try {
      // Skip if already connected - just verify connection is still alive
      if (this.isConnected && this.currentCredentials) {
        const stillAlive = await this.verifyConnection()
        if (stillAlive) {
          this.consecutiveHealthCheckFailures = 0
        } else {
          this.consecutiveHealthCheckFailures += 1
          Logger.debug(
            `LCU health check failed (${this.consecutiveHealthCheckFailures}/${this.MAX_HEALTH_CHECK_FAILURES})`
          )
        }

        if (this.consecutiveHealthCheckFailures >= this.MAX_HEALTH_CHECK_FAILURES) {
          this.isConnected = false
          this.currentCredentials = null
          this.consecutiveHealthCheckFailures = 0
          Logger.info('LCU disconnected')
          this.emit('disconnected')
        }
        return
      }
      
      const credentials = await this.findLCUCredentials()
      
      if (credentials && !this.isConnected && await this.verifyCredentials(credentials)) {
        this.currentCredentials = credentials
        this.isConnected = true
        this.consecutiveHealthCheckFailures = 0
        Logger.info(`LCU connected: port=${credentials.port}, pid=${credentials.pid}`)
        this.emit('connected', credentials)
      } else if (credentials) {
        // lockfile 和日志在客户端异常退出后可能残留。只有经过本地 API
        // 认证的凭据才能触发 connected，避免连接/断开状态反复抖动。
        Logger.debug(`Ignoring stale LCU credentials: port=${credentials.port}, pid=${credentials.pid}`)
      }
    } catch (error: any) {
      Logger.debug('LCU polling failed', error?.message || error)
    } finally {
      this.isPolling = false
    }
  }
  
  private async verifyConnection(): Promise<boolean> {
    return this.currentCredentials
      ? this.verifyCredentials(this.currentCredentials)
      : false
  }

  private async verifyCredentials(credentials: LCUCredentials): Promise<boolean> {
    // riotclient endpoint is available earliest during startup; gameflow is a
    // compatibility fallback for regional clients with a different plugin set.
    for (const endpoint of LCU_HEALTH_ENDPOINTS) {
      if (await this.probeEndpoint(credentials, endpoint)) return true
    }
    return false
  }

  private async probeEndpoint(credentials: LCUCredentials, endpoint: string): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      const finish = (reachable: boolean) => {
        if (settled) return
        settled = true
        resolve(reachable)
      }

      const request = httpsRequest({
        hostname: '127.0.0.1',
        port: credentials.port,
        path: endpoint,
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`riot:${credentials.token}`).toString('base64')}`,
          Accept: 'application/json',
          Connection: 'close',
        },
        rejectUnauthorized: false,
        agent: false,
        timeout: this.HEALTH_CHECK_TIMEOUT,
      }, response => {
        response.resume()
        finish(
          response.statusCode !== undefined
          && response.statusCode >= 200
          && response.statusCode < 300
        )
      })

      request.on('timeout', () => {
        finish(false)
        request.destroy()
      })
      request.on('error', () => finish(false))
      request.end()
    })
  }
  
  private async findLCUCredentials(): Promise<LCUCredentials | null> {
    // 方法1: 使用tasklist获取PID，再从进程命令行获取凭据
    const pid = await this.getLolClientPid()
    if (pid > 0) {
      const credentialsFromProcess = await this.getCredentialsByPid(pid)
      if (credentialsFromProcess) {
        return credentialsFromProcess
      }
    }
    
    // 方法2: 从lockfile获取
    const credentialsFromLockfile = await this.getCredentialsFromLockfile()
    if (credentialsFromLockfile) {
      return credentialsFromLockfile
    }

    // 方法3: 从日志文件获取（客户端以管理员权限运行时的可靠备选方案）
    const credentialsFromLog = await this.getCredentialsFromLogFile()
    if (credentialsFromLog) {
      return credentialsFromLog
    }
    
    return null
  }
  
  private async getLolClientPid(): Promise<number> {
    if (!this.tasklistPath) {
      return this.getLolClientPidSlowly()
    }
    
    try {
      const { stdout } = await execFileAsync(
        this.tasklistPath,
        ['/FI', 'IMAGENAME eq LeagueClientUx.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )

      const output = this.normalizeCommandOutput(stdout)
      const csvMatch = output.match(/^\s*"LeagueClientUx\.exe","(\d+)"/im)
      const tableMatch = output.match(/LeagueClientUx\.exe\s+(\d+)/i)
      const match = csvMatch || tableMatch
      if (match) {
        return parseInt(match[1], 10)
      }
      
      return 0
    } catch (error) {
      return this.getLolClientPidSlowly()
    }
  }
  
  private getLolClientPidSlowly(): number {
    try {
      const result = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Process -Name "LeagueClientUx" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id)',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )
      const pid = parseInt(this.normalizeCommandOutput(result).trim(), 10)
      return isNaN(pid) ? 0 : pid
    } catch {
      return 0
    }
  }
  
  private async getCredentialsByPid(pid: number): Promise<LCUCredentials | null> {
    try {
      const { stdout } = await execFileAsync(
        'wmic.exe',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/format:list'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )

      const credentials = this.parseCommandLineCredentials(stdout, pid, 'wmic')
      if (credentials) {
        return credentials
      }
    } catch {
      // 新版Windows可能未安装WMIC，继续尝试PowerShell
    }

    // WMIC存在但因权限返回空命令行时也必须继续尝试PowerShell
    return this.getCredentialsByPidViaPowerShell(pid)
  }
  
  private async getCredentialsByPidViaPowerShell(pid: number): Promise<LCUCredentials | null> {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )

      return this.parseCommandLineCredentials(stdout, pid, 'PowerShell')
    } catch {
      return null
    }
  }

  private normalizeCommandOutput(output: string | Buffer): string {
    return String(output).replace(/^\uFEFF/, '').replace(/\0/g, '')
  }

  private parseCommandLineCredentials(
    output: string | Buffer,
    pid: number,
    source: string
  ): LCUCredentials | null {
    const commandLine = this.normalizeCommandOutput(output)
    const portMatch = commandLine.match(/(?:^|\s)["']?--app-port(?:=|\s+)["']?(\d+)/i)
    const tokenMatch = commandLine.match(
      /(?:^|\s)["']?--remoting-auth-token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i
    )

    if (!portMatch || !tokenMatch) return null

    const port = parseInt(portMatch[1], 10)
    const token = tokenMatch[1] || tokenMatch[2] || tokenMatch[3]
    if (!Number.isInteger(port) || port <= 0 || !token) return null

    Logger.info(`Got LCU credentials via ${source}: port=${port}`)
    return { port, token, pid }
  }
  
  /**
   * 从LeagueClientUx日志文件中读取凭据
   */
  private async getCredentialsFromLogFile(): Promise<LCUCredentials | null> {
    const registryPath = this.getLoLPathFromRegistry()
    if (!registryPath) return null
    
    const logDir = join(registryPath, 'LeagueClient')
    if (!existsSync(logDir)) return null
    
    try {
      const files = readdirSync(logDir)
      const uxLogFiles = files
        .filter(f => f.includes('LeagueClientUx.log') && !f.includes('Helper'))
        .sort()
        .reverse()
      
      if (uxLogFiles.length === 0) return null
      
      const latestLog = join(logDir, uxLogFiles[0])
      const content = await readFile(latestLog, 'utf8')
      const lines = content.split('\n').slice(0, 20).join('\n')
      
      const pidMatch = uxLogFiles[0].match(/_(\d+)_LeagueClientUx/)
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0

      return this.parseCommandLineCredentials(lines, pid, 'log file')
    } catch (error: any) {
      // Silent
    }
    
    return null
  }
  
  private async getCredentialsFromLockfile(): Promise<LCUCredentials | null> {
    const registryPath = this.getLoLPathFromRegistry()
    if (registryPath) {
      const possibleSubPaths = [
        'lockfile',
        'LeagueClient/lockfile',
        'Game/lockfile',
      ]
      
      for (const subPath of possibleSubPaths) {
        const lockfilePath = join(registryPath, subPath)
        if (existsSync(lockfilePath)) {
          const credentials = await this.parseLockfile(lockfilePath)
          if (credentials) {
            return credentials
          }
        }
      }
    }
    
    const possiblePaths = [
      'C:/Riot Games/League of Legends/lockfile',
      'D:/Riot Games/League of Legends/lockfile',
      'E:/Riot Games/League of Legends/lockfile',
      'F:/Riot Games/League of Legends/lockfile',
      ...(this.installPath ? [
        join(this.installPath, 'lockfile'),
        join(this.installPath, 'LeagueClient/lockfile'),
      ] : []),
    ]
    
    for (const lockfilePath of possiblePaths) {
      try {
        if (existsSync(lockfilePath)) {
          const credentials = await this.parseLockfile(lockfilePath)
          if (credentials) {
            return credentials
          }
        }
      } catch {
        // Continue
      }
    }
    
    return null
  }
  
  private async parseLockfile(lockfilePath: string): Promise<LCUCredentials | null> {
    try {
      const content = await readFile(lockfilePath, 'utf8')
      const parts = content.split(':')
      
      if (parts.length >= 5) {
        const pid = parseInt(parts[1], 10)
        const port = parseInt(parts[2], 10)
        const token = parts[3]
        
        if (port > 0 && token) {
          Logger.info(`Got LCU credentials via lockfile: port=${port}`)
          this.installPath = lockfilePath.replace(/[/\\]lockfile$/, '')
          return { port, token, pid }
        }
      }
    } catch (error: any) {
      // Silent
    }
    
    return null
  }
  
  getCredentials(): LCUCredentials | null {
    return this.currentCredentials
  }
  
  getIsConnected(): boolean {
    return this.isConnected
  }
  
  getInstallPath(): string | null {
    return this.installPath
  }
  
  /**
   * 从Windows注册表获取国服LOL安装路径
   */
  private getLoLPathFromRegistry(): string | null {
    try {
      // reg.exe使用系统代码页输出，中文安装路径按UTF-8读取会乱码；
      // PowerShell显式使用UTF-8，保证国服的中文路径可以被Node正确解析。
      const result = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-ItemProperty -LiteralPath "HKCU:\\SOFTWARE\\Tencent\\LOL" -ErrorAction Stop).InstallPath',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 }
      )

      const installPath = this.normalizeCommandOutput(result).trim()
      if (installPath) {
        const gamePath = installPath.replace(/[/\\]TCLS$/i, '')
        return gamePath
      }
    } catch {
      // Silent
    }
    
    return null
  }
}
