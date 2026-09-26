import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type SqliteDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { P7Gateway } from '../src/p7-gateway.js'
import { createP7Snapshot } from '../src/p7-snapshot.js'
import { config, frames, streamFrames } from './p7-fixtures.js'
import { composeAgentSystem, seedOrder } from '../../agent/test/helpers.js'
import { ChatModelPolicyScorer } from '../../agent/src/policy-scorer.js'
import { UserSimulator } from '../../eval/src/simulator.js'
import { judgeTranscript } from '../../eval/src/judge.js'

const databases: SqliteDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** 独立组合根注入现有消费者 不改动公共生产装配和业务执行 */
describe.each(['anthropic_messages', 'openai_chat'] as const)(
  '%s 现有消费者适配试验',
  (protocol) => {
    function setup() {
      const db = createMemoryDatabase()
      databases.push(db)
      const ledger = new P7Ledger(db)
      const base = config()
      const gateway = new P7Gateway(
        createP7Snapshot(
          config({
            protocol,
            maxOutputTokens: 3000,
            capabilities: { ...base.capabilities, contextTokens: 10000, maxOutputTokens: 3000 },
          }),
        ),
        ledger,
      )
      return { gateway, ledger, db }
    }

    it('主 Agent 原循环查单后结案 两次调用均入账', async () => {
      const { gateway, ledger, db } = setup()
      let turn = 0
      let runId = ''
      const transport = {
        mode: 'simulation' as const,
        stream: () => {
          turn++
          return streamFrames(
            frames(
              protocol,
              turn === 1
                ? {
                    tools: 1,
                    toolName: 'get_order',
                    json: ['{"orderNo":"SO-2026-0003"}'],
                    idPrefix: 'query',
                  }
                : {
                    text: '订单已经签收',
                    tools: 1,
                    toolName: 'conclude',
                    json: ['{"summary":"查单完成"}'],
                    idPrefix: 'conclude',
                  },
            ),
          )
        },
      }
      const system = composeAgentSystem([], 4, {
        info: { provider: 'fixture', model: 'fixture-v1' },
        stream: (request) => gateway.chatModel(runId, 'main_agent', transport).stream(request),
      })
      seedOrder(system.repos, {
        orderNo: 'SO-2026-0003',
        status: 'delivered',
        deliveredAt: '2026-09-15T12:00:00.000Z',
      })
      const run = await system.runService.start({
        customerId: 'C1001',
        model: 'fixture-v1',
        promptVersion: 'prompt-v1',
      })
      runId = run.runId
      const outcome = await system.runner.start(runId, '查询订单 SO-2026-0003', {
        runId,
        actor: { role: 'customer', customerId: 'C1001' },
        faults: null,
      })
      expect(outcome).toBe('completed')
      expect(ledger.rows()).toHaveLength(2)
      expect(ledger.totals().committed).toBe(40)
      expect(db.prepare('SELECT DISTINCT run_id FROM p7_calls').all()).toEqual([{ run_id: runId }])
    })

    it('政策重排 用户模拟器与 Judge 共用累计账本', async () => {
      const { gateway, ledger, db } = setup()
      const model = (purpose: 'rerank' | 'simulator' | 'judge', text: string) =>
        gateway.chatModel('eval-run', purpose, {
          mode: 'simulation',
          stream: () => streamFrames(frames(protocol, { text })),
        })
      const scorer = new ChatModelPolicyScorer(
        model('rerank', '[{"articleId":"p1","score":8,"reason":"匹配退货"}]'),
      )
      expect(
        await scorer.score('质量问题退货', [
          {
            articleId: 'p1',
            policyVersion: 'v1',
            title: '质量问题退货',
            content: '质量问题支持退货',
            source: 'fixture',
            createdAt: '2026-09-25',
          },
        ]),
      ).toHaveLength(1)
      const simulator = new UserSimulator({
        model: model('simulator', '我要查询订单'),
        scenario: {
          persona: 'normal',
          reasonForContact: '查询订单',
          known: [],
          instructions: '询问物流',
          maxTurns: 1,
        },
      })
      expect((await simulator.openingMessage()).text).toBe('我要查询订单')
      expect(
        await judgeTranscript(
          { model: model('judge', '[{"rubric":"礼貌","passed":true,"reason":"用语礼貌"}]') },
          ['礼貌'],
          [{ role: 'agent', text: '您好' }],
        ),
      ).toEqual([])
      expect(ledger.totals().committed).toBe(60)
      expect(db.prepare('SELECT purpose FROM p7_calls ORDER BY purpose').all()).toEqual([
        { purpose: 'judge' },
        { purpose: 'rerank' },
        { purpose: 'simulator' },
      ])
    })
  },
)
