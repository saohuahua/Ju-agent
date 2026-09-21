import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 前端只通过 HTTP 消费 API 不直接导入工作区包
  // 跨域由 API 侧 CORS 中间件放行
  reactStrictMode: true,
  // phosphor 图标库 barrel 含 1500+ 模块 默认优化列表不含它
  // 不加此项 dev 模式每次编译都要处理整个图标模块图 首屏编译可达 15s
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react'],
  },
}

export default nextConfig
