const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { appBuilderPath } = require('app-builder-bin')

const execFileAsync = promisify(execFile)

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return

  const appInfo = context.packager.appInfo
  const executable = path.join(context.appOutDir, `${appInfo.productFilename}.exe`)
  const requestedExecutionLevel =
    context.packager.platformSpecificBuildOptions.requestedExecutionLevel
  const productVersion = `${appInfo.version}.0`.split('.').slice(0, 4).join('.')
  const args = [
    executable,
    '--set-version-string', 'FileDescription', appInfo.productName,
    '--set-version-string', 'ProductName', appInfo.productName,
    '--set-version-string', 'LegalCopyright', appInfo.copyright,
    '--set-version-string', 'InternalName', appInfo.productFilename,
    '--set-version-string', 'OriginalFilename', `${appInfo.productFilename}.exe`,
    '--set-file-version', appInfo.version,
    '--set-product-version', productVersion,
  ]

  if (requestedExecutionLevel && requestedExecutionLevel !== 'asInvoker') {
    args.push('--set-requested-execution-level', requestedExecutionLevel)
  }

  // app-builder's native PE resource editor works cross-platform and avoids a
  // Wine dependency when producing the Windows artifact from Linux/WSL.
  await execFileAsync(appBuilderPath, ['rcedit', '--args', JSON.stringify(args)])
}
