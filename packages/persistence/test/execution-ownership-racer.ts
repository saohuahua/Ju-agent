import { openDatabase } from '../src/db.js'
import { ExecutionOwnershipRepository } from '../src/execution-ownership-repository.js'

/** 自建子进程只操作测试临时库 不触碰演示服务或真实渠道 */
const db = openDatabase(process.argv[2]!)
db.pragma('busy_timeout = 5000')
const ownership = new ExecutionOwnershipRepository(db)
process.send?.({ ready: true })
process.once('message', () => {
  let won = false
  try {
    if (process.argv[3] === 'legacy') ownership.acquireLegacy('refund:race')
    else ownership.takeoverWithCommand('refund:race', () => ({ commandId: 'p6-race' }))
    won = true
  } catch {
    won = false
  }
  // 许可提交后立即退出 不释放许可 用于模拟渠道调用前的崩溃窗口
  process.send?.({ won }, () => process.exit(0))
})
