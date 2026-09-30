import { openDatabase, initializeDemo, P7Ledger } from '@aftersales/persistence'
import { conversationDemoOptions } from '@aftersales/runtime'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const businessPath = resolve(process.env.DB_PATH ?? '/data/business/app.db')
const channelPath = resolve(process.env.P6_CHANNEL_DB_PATH ?? '/data/channel/channel.db')
const mode = process.argv[2]
const target = resolve(process.argv[3] ?? '/backup')
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

// 恢复只接受两个空目录 不覆盖已有库及旁文件
if (mode === 'restore') {
  const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >
  for (const [name, path] of [
    ['business.db', businessPath],
    ['channel.db', channelPath],
  ]) {
    if (!name || !path) throw new Error('恢复路径缺失')
    const directory = resolve(path, '..')
    mkdirSync(directory, { recursive: true })
    if (readdirSync(directory).length) throw new Error('恢复目标必须是新空卷')
    if (hash(join(target, name)) !== manifest[name]) throw new Error('备份哈希不匹配')
  }
  for (const [name, path] of [
    ['business.db', businessPath],
    ['channel.db', channelPath],
  ]) {
    copyFileSync(join(target, name!), path!)
  }
  console.log('已恢复到空卷')
} else {
  const db = openDatabase(businessPath)
  const channel = openDatabase(channelPath)
  try {
    if (mode === 'prepare') {
      // 仅新验收卷允许调整基础订单 不预造审批任务或资金结果
      initializeDemo(db)
      if (db.prepare('SELECT 1 FROM agent_runs LIMIT 1').get()) throw new Error('验收卷已使用')
      db.prepare(
        "UPDATE orders SET total_amount_cents = 29900 WHERE order_no = 'SO-2026-0001'",
      ).run()
      db.prepare(
        "UPDATE orders SET customer_id = 'C1001', delivered_at = ?, total_amount_cents = 29900 WHERE order_no IN ('SO-2026-0003','SO-2026-0005','SO-2026-0006')",
      ).run(new Date().toISOString())
      console.log('基础订单准备完成')
    } else if (mode === 'unknown-fee') {
      const ledger = new P7Ledger(db)
      ledger.reserve(
        {
          callId: 'p10-unknown',
          operationId: 'p10-unknown',
          runId: 'p10-probe',
          purpose: 'judge',
          attempt: 1,
        },
        conversationDemoOptions(true).snapshot,
        1234,
      )
      ledger.finish('p10-unknown', null, null, 'CANCELLED')
      console.log('原账本未知费用占位已保存')
    } else if (mode === 'unknown-fund') {
      const row = db.prepare("SELECT value FROM counters WHERE key = 'RT-2026'").get() as {
        value: number
      }
      channel
        .prepare('INSERT INTO p6_channel_faults VALUES (?,?)')
        .run(`refund:RT-2026-${String(row.value + 1).padStart(4, '0')}`, 'unknown')
      console.log('原模拟渠道故障已设置')
    } else if (mode === 'snapshot') {
      console.log(
        JSON.stringify({
          orders: db.prepare('SELECT order_no,status FROM orders ORDER BY order_no').all(),
          runs: db.prepare('SELECT run_id,status FROM agent_runs ORDER BY run_id').all(),
          tasks: db
            .prepare('SELECT task_id,command_id,status,attempt FROM p6_tasks ORDER BY task_id')
            .all(),
          links: db.prepare('SELECT * FROM p6_conversation_refunds ORDER BY run_id').all(),
          refunds: db.prepare('SELECT return_no,status FROM refunds ORDER BY return_no').all(),
          ownership: db.prepare('SELECT * FROM execution_ownership').all(),
          events: db
            .prepare(
              "SELECT run_id,type,payload_json FROM agent_events WHERE type IN ('agent.tool_results','run.completed') ORDER BY rowid",
            )
            .all(),
          calls: db
            .prepare('SELECT call_id,status,reserved,actual,outcome FROM p7_calls ORDER BY call_id')
            .all(),
          totals: new P7Ledger(db).totals(),
          channel: channel
            .prepare(
              'SELECT business_key,status,submissions,charges FROM p6_channel ORDER BY business_key',
            )
            .all(),
        }),
      )
    } else if (mode === 'backup') {
      mkdirSync(target, { recursive: true })
      if (readdirSync(target).length) throw new Error('备份目录必须为空')
      // 调用方必须先停写入 两库在线备份接口包含 WAL 已提交内容
      await db.backup(join(target, 'business.db'))
      await channel.backup(join(target, 'channel.db'))
      writeFileSync(
        join(target, 'manifest.json'),
        JSON.stringify(
          {
            'business.db': hash(join(target, 'business.db')),
            'channel.db': hash(join(target, 'channel.db')),
          },
          null,
          2,
        ),
      )
      console.log('两库备份完成')
    } else if (mode === 'integrity') {
      for (const connection of [db, channel]) {
        if (JSON.stringify(connection.pragma('integrity_check')) !== '[{"integrity_check":"ok"}]')
          throw new Error('数据库完整性失败')
      }
      console.log('两库完整性通过')
    } else throw new Error(`未知数据操作 ${mode} ${existsSync(target)}`)
  } finally {
    db.close()
    channel.close()
  }
}
