/**
 * 持久化包出口
 *
 * 提供 SQLite 仓储实现 夹具与数据库工具
 * 组合根 api 与 eval 负责装配 领域包不感知本包
 */

export {
  openDatabase,
  createMemoryDatabase,
  migrate,
  clearBusinessData,
  type SqliteDatabase,
} from './db.js'
export {
  SqliteOrderRepository,
  SqliteShipmentRepository,
  SqliteCustomerRepository,
  SqliteReturnRepository,
  SqliteRefundRepository,
  SqliteCompensationRepository,
  SqlitePriceProtectionRepository,
  SqliteSkuPriceRepository,
  SqlitePolicyArticleRepository,
  SqliteApprovalRepository,
  SqlitePolicyRepository,
} from './business-repositories.js'
export {
  SqliteAuditRepository,
  SqliteEventRepository,
  SqliteToolExecutionRepository,
  SqliteCheckpointRepository,
  SqliteIdempotencyRepository,
  SqliteAgentRunRepository,
  SqliteLeaseRepository,
  SqliteBusinessNoGenerator,
  SqliteRatingRepository,
  SqliteAnalyticsReadModel,
  saveEvalReport,
  listEvalReports,
  queryTable,
} from './infrastructure-repositories.js'
export {
  BASELINE_FIXTURE,
  BASELINE_FROZEN_TIME,
  loadFixture,
  loadPolicyArticles,
  type FixturePatch,
} from './fixtures.js'
export * from './desk-repository.js'
export * from './approval-execution-repository.js'
export * from './case-closure-repository.js'
export * from './approval-progress-repository.js'
export * from './p6-migration.js'
export * from './p6-task-repository.js'
export * from './p6-business-adapter.js'
export * from './p6-payment-simulator.js'
export * from './p7-migration.js'
export * from './p7-ledger.js'
export * from './conversation-journal.js'
export * from './execution-ownership-repository.js'
export * from './execution-ownership-p6.js'
export * from './p6-owned-after-sale.js'
