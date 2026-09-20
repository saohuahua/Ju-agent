/**
 * 契约枚举转发
 *
 * 领域包的消费者经常同时需要实体与枚举
 * 这里只做转发 不引入新类型
 */

export type {
  ApprovalStatus,
  ErrorCode,
  EventType,
  Intent,
  RefundStatus,
  ReturnReason,
  ReturnStatus,
  ReturnType,
  RiskLevel,
  RunStatus,
} from '@aftersales/contracts'
