import { resolve } from 'node:path'

export const projectRoot = resolve(import.meta.dirname, '..')
export const localOfflineRoot = resolve(projectRoot, 'data/local-offline')
export const businessPath = resolve(localOfflineRoot, 'business/app.db')
export const channelPath = resolve(localOfflineRoot, 'channel/channel.db')
export const runningPath = resolve(localOfflineRoot, '.running')
