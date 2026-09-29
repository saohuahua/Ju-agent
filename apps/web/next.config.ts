import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 前端只通过 HTTP 消费 API 不直接导入工作区包
  reactStrictMode: true,
  // 两种本地入口使用独立构建目录 避免开发产物相互覆盖
  distDir: process.env.OFFLINE_DEV_INSTANCE === '1' ? '.next-offline' : undefined,
  // 浏览器只访问同源路径 代理目标由服务器运行环境决定
  async rewrites() {
    const origin =
      process.env.OFFLINE_API_ORIGIN ??
      (process.env.OFFLINE_DEPLOYMENT === '1'
        ? 'http://api:8787'
        : process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8787')
    return [{ source: '/api/:path*', destination: `${origin}/api/:path*` }]
  },
  // phosphor 图标库 barrel 含 1500+ 模块 默认优化列表不含它
  // 不加此项 dev 模式每次编译都要处理整个图标模块图 首屏编译可达 15s
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react'],
    // 页面只包含客户端入口 业务数据由身份隔离的查询缓存独立维护
    // 短时复用路由载荷避免往返已访问页面时再次等待服务端
    // 未来若引入服务端业务数据需同时审查此缓存窗口与失效策略
    staleTimes: { dynamic: 30 },
  },
}

export default nextConfig
