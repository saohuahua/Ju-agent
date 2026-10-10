/**
 * 原生依赖预编译包装脚本
 *
 * better-sqlite3 是原生模块 需要与 Node ABI 匹配的二进制
 * 它的 install 脚本默认从 GitHub Releases 下载 国内网络直连会超时
 * 随后回退到 node-gyp 本地编译 又要求安装 Visual Studio C++ 工具链
 *
 * 这里由项目统一处理 使用 npmmirror 预编译包镜像
 * better-sqlite3 自身构建已在 pnpm-workspace.yaml 的 allowBuilds 中关闭
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BINARY_HOST =
  process.env.BETTER_SQLITE3_BINARY_HOST ?? 'https://npmmirror.com/mirrors/better-sqlite3'

/** 依赖缺失或平台不支持预编译包时跳过 不让安装整体失败 */
function main() {
  const require = createRequire(import.meta.url)
  let packageDir
  try {
    packageDir = dirname(require.resolve('better-sqlite3/package.json', {
      paths: [join(process.cwd(), 'packages', 'persistence')],
    }))
  } catch {
    console.log('[native-deps] 未找到 better-sqlite3 跳过预编译安装')
    return
  }

  const binding = join(packageDir, 'build', 'Release', 'better_sqlite3.node')
  if (existsSync(binding)) {
    console.log('[native-deps] better-sqlite3 二进制已存在')
    return
  }

  // pnpm 把传递依赖放在包目录的上一级 node_modules 按 better-sqlite3 的解析路径查找
  const packageRequire = createRequire(join(packageDir, 'package.json'))
  let prebuildInstall
  try {
    prebuildInstall = packageRequire.resolve('prebuild-install/bin.js')
  } catch {
    console.log('[native-deps] 未找到 prebuild-install 跳过')
    return
  }

  console.log(`[native-deps] 从 ${BINARY_HOST} 下载 better-sqlite3 预编译包`)
  try {
    execFileSync(process.execPath, [prebuildInstall], {
      cwd: packageDir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_better_sqlite3_binary_host: BINARY_HOST },
    })
  } catch (error) {
    console.error('[native-deps] 预编译包下载失败', error instanceof Error ? error.message : error)
    console.error('[native-deps] 请检查网络后重新执行 pnpm install 或 pnpm demo')
    process.exitCode = 1
  }
}

main()
