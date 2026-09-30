import { openDatabase } from '../../../persistence/src/db.js'
import { P6TaskRepository } from '../../../persistence/src/p6-task-repository.js'
import { P7Ledger } from '../../../persistence/src/p7-ledger.js'
import { p6GatewayModel } from '../../src/p6-p7-model.js'
import { P6Worker } from '../../src/p6-worker.js'

const [path, fault] = process.argv.slice(2)
if (!path) throw new Error('缺少实验数据库路径')
const db = openDatabase(path)
const worker = new P6Worker(
  new P6TaskRepository(db),
  {
    model: p6GatewayModel(new P7Ledger(db), async (_input, _snapshot, signal, usage) => {
      signal.throwIfAborted()
      console.log('供应商模拟尝试')
      // 直接退出以保留未结算的 held 记录 不用异常回调模拟崩溃
      if (fault === 'during-model') process.exit(73)
      usage({ inputTokens: 10, outputTokens: 5 })
      return { text: '完整模拟结果' }
    }),
    read: async () => ({ verified: true }),
    payment: {
      execute: async () => {
        throw new Error('无资金计划')
      },
      query: async () => {
        throw new Error('无资金计划')
      },
    },
    applyPayment: () => {
      throw new Error('无资金计划')
    },
    boundary: async (name) => {
      if (name === fault) process.exit(73)
    },
  },
  {
    owner: `joint-${process.pid}`,
    // 进程加载与并行测试调度不能耗尽用于验证模型恢复的租约
    leaseMs: 1000,
    callTimeoutMs: 2000,
    maxAttempts: 2,
    retryDelayMs: 0,
    limits: { global: 1, customer: 1, provider: 1, tool: 1 },
  },
)
// 恢复等待真实租约到期 不假定子进程启动耗时一定大于租约
for (let poll = 0; poll < 100; poll++) {
  if (await worker.runOnce()) break
  if (poll === 99) throw new Error('恢复进程未认领到任务')
  await new Promise((resolve) => setTimeout(resolve, 50))
}
db.close()
