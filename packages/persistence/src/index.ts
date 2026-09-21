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
