import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 从已经完成的实验记录汇总事实 不重新运行支付或修改数据库
 * 输入目录必须包含完整清单与终态快照 缺少材料时直接报错避免生成伪验收
 */
const directory = process.argv[2]
if (!directory) throw new Error('请传入 P6 实验结果目录')
const root = resolve(directory)
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
  generatedAt: string
  scope: string
  scenarios: { name: string; passed: boolean }[]
}
const rows = manifest.scenarios.map((scenario) => {
  const folder = join(root, scenario.name)
  const snapshot = JSON.parse(readFileSync(join(folder, 'terminal-state.json'), 'utf8')) as {
    passed: boolean
    p6_tasks: { status: string; generation: number }[]
    compensations: { status: string }[]
    channel: { submissions: number; charges: number }[]
    channelQueries: unknown[]
  }
  const logs = readFileSync(join(folder, 'process.log'), 'utf8')
  return {
    scenario: scenario.name,
    passed: scenario.passed && snapshot.passed,
    tasks: snapshot.p6_tasks.map((task) => `${task.status} g${task.generation}`).join(' / '),
    business: snapshot.compensations.map((item) => item.status).join(' / '),
    submissions: snapshot.channel.reduce((sum, item) => sum + item.submissions, 0),
    charges: snapshot.channel.reduce((sum, item) => sum + item.charges, 0),
    queries: snapshot.channelQueries.length,
    modelCalls: logs.split('"event":"model-called"').length - 1,
  }
})
const lines = [
  '# P6 故障实验数据汇总',
  '',
  `原始运行时间：${manifest.generatedAt}`,
  '',
  `范围：${manifest.scope}`,
  '',
  `场景通过数：${rows.filter((row) => row.passed).length} / ${rows.length}`,
  '',
  '模型次数来自子进程日志 发送与成功次数来自独立渠道数据库 查询次数来自渠道查询记录',
  '这些计数是确定性故障夹具结果 不能推导生产成功率 性能提升或真实支付效果',
  '',
  '| 场景 | 断言通过 | 任务状态与代次 | 业务终态 | POST 次数 | 成功动作 | 查询次数 | 模型次数 |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (row) =>
      `| [${row.scenario}](${row.scenario}/terminal-state.json) | ${row.passed} | ${row.tasks} | ${row.business} | ${row.submissions} | ${row.charges} | ${row.queries} | ${row.modelCalls} |`,
  ),
  '',
  '## 分析口径',
  '',
  '- completed 只代表本命令完成 资金成功必须同时检查业务记录和渠道成功动作',
  '- needs_confirmation 的成功动作计数为零不等于证明真实资金没有发生 这里只是夹具的已知设置',
  '- mid-stream 的模型次数为二是未确认模型输出的重新获取 不是重复执行资金动作',
  '- 新运行场景有两个任务 只有一个渠道发送和一个成功动作 说明业务键没有绑定运行编号',
  '- 取消后的业务成功表示已发生资金事实已核验 不表示撤销资金或退款回滚',
  '- SSE 正式挂载与旧 Agent 循环改造不在该进程报告的已验证范围',
  '',
]
writeFileSync(join(root, 'analysis.md'), lines.join('\n'))
console.log(join(root, 'analysis.md'))
