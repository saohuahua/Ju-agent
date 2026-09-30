import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { P8AnalysisReply, p8FactsFromEvidence } from '../../contracts/src/p8-investigation.js'
import type { P6Task } from '../../contracts/src/p6-durable.js'
import { P7Error, type P7Snapshot } from '../../contracts/src/p7-model-gateway.js'
import type {
  P8BranchResult,
  P8Evidence,
  P8Input,
  P8Role,
} from '../../contracts/src/p8-investigation.js'
import { buildKnowledgeSnapshot } from '../../domain/src/knowledge.js'
import { POLICY_VERSION, decidePolicy } from '../../domain/src/policy.js'
import type { Order, Shipment, PolicyArticle } from '../../domain/src/entities.js'
import {
  SqliteOrderRepository,
  SqliteShipmentRepository,
  SqlitePolicyArticleRepository,
} from '../../persistence/src/business-repositories.js'
import type { SqliteDatabase } from '../../persistence/src/db.js'
import { P6OwnershipLost } from '../../persistence/src/p6-task-repository.js'
import {
  P8InvestigationRepository,
  p8EvidenceHash,
} from '../../persistence/src/p8-investigation-repository.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { readP8BusinessReferences } from '../../persistence/src/p8-business-references.js'
import { P6Worker } from './p6-worker.js'
import { P7Gateway, type P7Transport } from './p7-gateway.js'
import { restoreP7Snapshot } from './p7-snapshot.js'

export interface P8Options {
  transport(snapshot: P7Snapshot, role: P8Role): P7Transport
  leaseMs?: number
  /** 故障实验在持久边界退出 正常入口不传 */
  boundary?(name: string, task: P6Task): Promise<void>
}

/** 仅暴露调查和建议 无资金服务或正式客户路由 */
export class P8Investigation {
  readonly repo: P8InvestigationRepository
  readonly ledger: P7Ledger
  constructor(
    readonly db: SqliteDatabase,
    private readonly options: P8Options,
  ) {
    this.repo = new P8InvestigationRepository(db)
    this.ledger = new P7Ledger(db)
  }

  /** 从原读取端口捕获版本 冻结后两种调度只消费相同证据 */
  async capture(customerId: string, orderNo: string, policyVersion = POLICY_VERSION) {
    const order = await new SqliteOrderRepository(this.db).findByOrderNo(orderNo)
    if (!order || order.customerId !== customerId) throw new Error('P8 无权读取订单')
    const shipment = await new SqliteShipmentRepository(this.db).findByOrderNo(orderNo)
    const articles = await new SqlitePolicyArticleRepository(this.db).listByVersion(policyVersion)
    const knowledgeVersion = buildKnowledgeSnapshot(articles).snapshotId
    const evidence: P8Evidence[] = []
    const add = (kind: P8Evidence['kind'], version: string, data: object) => {
      const value = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
      evidence.push({
        kind,
        version,
        customerId,
        orderNo,
        data: value,
        ref: JSON.stringify([
          'p8-evidence-v1',
          customerId,
          orderNo,
          kind,
          version,
          p8EvidenceHash(value),
        ]),
      })
    }
    add('order', String(order.version), order)
    if (shipment) add('shipment', String(shipment.version), shipment)
    for (const article of articles) add('policy', policyVersion, article)
    const businessReferences = this.businessReferences(customerId, orderNo)
    return { customerId, orderNo, policyVersion, knowledgeVersion, evidence, businessReferences }
  }

  private businessReferences(customerId: string, orderNo: string) {
    return readP8BusinessReferences(this.db, customerId, orderNo)
  }

  accept(input: P8Input): P6Task {
    return this.db.transaction(() => this.validateAndAccept(input)).immediate()
  }

  /** 同一写事务验证源记录并受理 避免校验后事实被另一进程替换 */
  private validateAndAccept(input: P8Input): P6Task {
    const snapshot = restoreP7Snapshot(input.snapshot)
    if (snapshot.mode !== 'simulation') throw new P7Error('LIVE_DISABLED')
    if (
      !input.experimentId.trim() ||
      !input.caseId.trim() ||
      !Number.isSafeInteger(input.repeat) ||
      input.repeat < 1 ||
      !['single', 'parallel'].includes(input.mode)
    )
      throw new Error('P8 实验身份非法')
    const replay = this.repo.replay(input)
    if (replay) return replay
    if (snapshot.knowledgeSnapshotId !== input.knowledgeVersion)
      throw new Error('P8 知识快照不一致')
    const articles = input.evidence
      .filter((item) => item.kind === 'policy')
      .map((item) => item.data as unknown as PolicyArticle)
    if (buildKnowledgeSnapshot(articles).snapshotId !== input.knowledgeVersion)
      throw new Error('P8 知识原文哈希不一致')
    const order = new SqliteOrderRepository(this.db).findByOrderNoSync(input.orderNo)
    if (!order || order.customerId !== input.customerId) throw new Error('P8 无权受理订单')
    const shipment = new SqliteShipmentRepository(this.db).findByOrderNoSync(input.orderNo)
    const policies = this.db
      .prepare(
        'SELECT article_id AS articleId, policy_version AS policyVersion, title, content, source, created_at AS createdAt FROM policy_articles WHERE policy_version = ?',
      )
      .all(input.policyVersion) as PolicyArticle[]
    if (buildKnowledgeSnapshot(policies).snapshotId !== input.knowledgeVersion)
      throw new Error('P8 政策原文已变化')
    if (
      input.evidence.filter((item) => item.kind === 'order').length !== 1 ||
      input.evidence.filter((item) => item.kind === 'shipment').length !== (shipment ? 1 : 0) ||
      articles.length !== policies.length
    )
      throw new Error('P8 原文集合不完整')
    for (const item of input.evidence) {
      const expected = JSON.stringify([
        'p8-evidence-v1',
        input.customerId,
        input.orderNo,
        item.kind,
        item.version,
        p8EvidenceHash(item.data),
      ])
      if (
        item.customerId !== input.customerId ||
        item.orderNo !== input.orderNo ||
        item.ref !== expected ||
        (item.kind === 'policy' && item.version !== input.policyVersion)
      )
        throw new Error('P8 证据归属或内容冲突')
      const source =
        item.kind === 'order'
          ? order
          : item.kind === 'shipment'
            ? shipment
            : policies.find((policy) => policy.articleId === item.data.articleId)
      if (!isDeepStrictEqual(item.data, source)) throw new Error('P8 原文与源记录冲突')
      if (item.kind !== 'policy' && item.version !== String((source as Order | Shipment).version))
        throw new Error('P8 原文版本冲突')
    }
    if (
      JSON.stringify(input.businessReferences) !==
      JSON.stringify(this.businessReferences(input.customerId, input.orderNo))
    )
      throw new Error('P8 业务引用必须来自原记录')
    return this.repo.accept(structuredClone(input))
  }

  private worker(tool: string, parentId: string) {
    const deny = async (): Promise<never> => {
      throw new Error('P8 没有资金执行能力')
    }
    return new P6Worker(
      this.repo.tasks,
      {
        handlers: {
          'p8-facts': (task, signal) => this.investigate(task, 'facts', signal),
          'p8-policy': (task, signal) => this.investigate(task, 'policy', signal),
          'p8-parent': (task, signal) => this.aggregate(task, signal),
        },
        model: deny,
        read: deny,
        payment: { execute: deny, query: deny },
        applyPayment: () => {
          throw new Error('P8 没有资金执行能力')
        },
      },
      {
        owner: `p8-${randomUUID()}`,
        tools: [tool],
        acceptedEvent: tool === 'p8-parent' ? `p8-ready:${parentId}` : `p8-branch:${parentId}`,
        leaseMs: this.options.leaseMs ?? 1000,
        callTimeoutMs: 120000,
        maxAttempts: 3,
        retryDelayMs: 0,
        limits: { global: 4, customer: 3, provider: 4, tool: 2 },
      },
    )
  }

  /** 调度方式由受理快照决定 恢复不允许切换模式 */
  async run(parentId: string, phase: 'facts' | 'branches' | 'all' = 'all'): Promise<void> {
    const input = this.repo.input(parentId)
    const parent = this.repo.tasks.get(parentId)!
    if (!['queued', 'running'].includes(parent.status)) return
    const roles: P8Role[] = phase === 'facts' ? ['facts'] : ['facts', 'policy']
    const work = async (role: P8Role) => {
      const link = this.repo.children(parentId).find((item) => item.role === role)!
      if (input.mode === 'single' && role === 'policy') {
        const facts = this.repo.children(parentId).find((item) => item.role === 'facts')!
        if (['queued', 'running'].includes(this.repo.tasks.get(facts.taskId)!.status)) return
      }
      if (['queued', 'running'].includes(this.repo.tasks.get(link.taskId)!.status))
        await this.worker(`p8-${role}`, parentId).runOnce()
    }
    if (input.mode === 'parallel' && phase !== 'facts') await Promise.all(roles.map(work))
    else for (const role of roles) await work(role)
    this.repo.notify(parentId)
    if (phase === 'all') await this.worker('p8-parent', parentId).runOnce()
  }

  private async investigate(task: P6Task, role: P8Role, signal: AbortSignal) {
    const parent = this.repo.parent(task.taskId)
    const input = this.repo.input(parent.taskId)
    const startedAt = Date.now()
    const base = {
      parentRunId: parent.runId,
      taskId: task.taskId,
      runId: task.runId,
      customerId: task.customerId,
      orderNo: input.orderNo,
      role,
      configVersion: input.snapshot.version,
      knowledgeVersion: input.knowledgeVersion,
      startedAt,
    }
    let result: P8BranchResult
    try {
      this.repo.evidence(task)
      const evidence = this.repo.tasks.step(task.taskId, 'p8-evidence') as P8Evidence[]
      const operationId = JSON.stringify(['p8-call-v1', task.taskId, 'analysis'])
      // 未确认的旧调用可能已付费 不通过换号或外层重试重新传输
      if (this.db.prepare('SELECT 1 FROM p7_calls WHERE operation_id = ?').get(operationId))
        throw new Error('P8 先前调用未确认 需人工核验费用与结果')
      await this.options.boundary?.('before-model', task)
      const model = new P7Gateway(
        restoreP7Snapshot(task.input.config.value),
        this.ledger,
      ).chatModel(
        input.mode === 'single' ? parent.runId : task.runId,
        input.mode === 'single' ? 'main_agent' : 'sub_agent',
        this.options.transport(input.snapshot, role),
        signal,
        operationId,
      )
      let text = ''
      for await (const event of model.stream({
        system: `P8 只读调查 ${role} 仅输出 facts citations unresolved 的 JSON 事实必须逐项引用原文 不得输出业务动作`,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: JSON.stringify({ role, evidence, userStatements: input.userStatements }),
              },
            ],
          },
        ],
        tools: [],
      })) {
        if (event.type === 'text_delta') text += event.text
        else if (event.type !== 'turn_completed') throw new Error('P8 不接受工具或资金指令')
      }
      signal.throwIfAborted()
      const reply = P8AnalysisReply.parse(JSON.parse(text))
      const expected = p8FactsFromEvidence(evidence)
      if (
        JSON.stringify(reply.facts) !== JSON.stringify(expected) ||
        JSON.stringify(reply.citations) !== JSON.stringify(evidence.map((item) => item.ref))
      )
        throw new Error('P8 模型证据冲突或引用缺失')
      const missing =
        role === 'facts'
          ? ['order', 'shipment']
              .filter((kind) => !evidence.some((item) => item.kind === kind))
              .map((kind) => `缺少 ${kind} 证据`)
          : evidence.some((item) => item.data.articleId === 'R2_lost_package')
            ? []
            : ['缺少丢件政策原文']
      result = {
        ...base,
        status: 'confirmed',
        ...reply,
        unresolved: [...reply.unresolved, ...missing],
        error: null,
        finishedAt: Date.now(),
      }
      await this.options.boundary?.('after-model-response', task)
    } catch (error) {
      if (error instanceof P6OwnershipLost) throw error
      signal.throwIfAborted()
      const message = error instanceof Error ? error.message : '调查失败'
      result = {
        ...base,
        status: error instanceof P7Error && error.code === 'TIMEOUT' ? 'timeout' : 'failed',
        facts: [],
        citations: [],
        unresolved: [`${role} 调查未完成`],
        error: message,
        finishedAt: Date.now(),
      }
    }
    signal.throwIfAborted()
    const confirmed = this.repo.confirm(task, result)
    if (!confirmed && this.repo.tasks.get(task.taskId)?.status === 'running')
      this.repo.tasks.finish(task, 'cancelled', '父流程已结束')
    await this.options.boundary?.('branch-confirmed', task)
  }

  private async aggregate(task: P6Task, signal: AbortSignal) {
    signal.throwIfAborted()
    const input = this.repo.input(task.taskId)
    const memory = this.repo.memory(task.taskId)
    const results = this.repo.children(task.taskId).map((link) => this.repo.result(link.taskId))
    const failed = results.some((result) => result?.status !== 'confirmed')
    const order = input.evidence.find((item) => item.kind === 'order')?.data as unknown as
      Order | undefined
    const shipment = input.evidence.find((item) => item.kind === 'shipment')?.data as unknown as
      Shipment | undefined
    const conflict = Boolean(
      order &&
      shipment &&
      ((['delivered', 'completed'].includes(order.status) && shipment.status === 'lost') ||
        (order.status === 'paid' && shipment.status === 'delivered')),
    )
    const reasons = [...memory.unresolved]
    let recommendation: 'controlled_review' | 'ask_user' | 'human_review' = 'ask_user'
    if (
      failed ||
      conflict ||
      input.policyVersion !== POLICY_VERSION ||
      memory.unknownActions.length
    ) {
      recommendation = 'human_review'
      reasons.push(
        conflict
          ? '订单与物流证据冲突'
          : memory.unknownActions.length
            ? '原业务动作结果未知'
            : '调查失败或政策版本不适用',
      )
      memory.unresolved = [...new Set([...memory.unresolved, ...reasons])]
    } else if (!reasons.length && order && shipment) {
      const decision = decidePolicy({
        type: 'refund_only',
        reason: 'lost_package',
        order,
        shipment,
        itemIds: null,
        clock: {
          now: () => new Date(input.acceptedAt),
          advanceTo: () => {
            throw new Error('P8 冻结时钟不可修改')
          },
        },
      })
      recommendation = decision.outcome === 'deny' ? 'ask_user' : 'controlled_review'
      reasons.push(decision.explanation)
      if (decision.outcome === 'deny') memory.unresolved.push('需补充承运商丢件认定')
    }
    await this.options.boundary?.('before-conclusion', task)
    signal.throwIfAborted()
    this.repo.conclude(task, {
      status: recommendation === 'controlled_review' ? 'complete' : 'incomplete',
      recommendation,
      reasons,
      memory,
      finishedAt: Date.now(),
    })
  }
}
