import type { ChatModel, ModelStreamEvent } from '@aftersales/agent'
import { P7Error } from '@aftersales/contracts'
import { conversationDemoOptions } from '@aftersales/runtime'

/** 旧会话恢复也只能明确失败 不能绕过持久入口调用真实供应商 */
class DisabledApiModel implements ChatModel {
  readonly info = { provider: 'disabled', model: 'live-disabled' }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield* []
    throw new P7Error('LIVE_DISABLED')
  }
}

/** 正式入口仅选择关闭或持久离线模式 不接受凭据或裸模型注入 */
export function resolveApiModelEntry(mode?: string) {
  if (mode && mode !== 'simulation') throw new P7Error('LIVE_DISABLED')
  return {
    model: new DisabledApiModel(),
    available: false,
    label: mode === 'simulation' ? '持久退款离线模拟' : '真实模型入口已关闭',
    durableConversation: mode === 'simulation' ? conversationDemoOptions(true, true) : undefined,
  }
}
