import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 前端只通过 HTTP 消费 API 不直接导入工作区包
  // 跨域由 API 侧 CORS 中间件放行
  reactStrictMode: true,
}

export default nextConfig
