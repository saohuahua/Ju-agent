'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, PanelRightClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/StatusBadge'
import { NavigationLink } from '@/components/NavigationLink'
import { useIdentity } from '@/lib/identity'
import { projectTimeline, timelineHint } from '@/lib/timeline'
import type { AgentEvent, RunStatus } from '@/lib/types'
import { DeskEmpty } from './DeskEmpty'

/** 展示持久化事件而不推断不存在的执行结果 */
export function AgentPanel({
  events,
  runId,
  status,
  connected,
  complete,
  hidden,
  onClose,
  children,
}: {
  events: AgentEvent[]
  runId: string
  status: RunStatus
  connected: boolean
  complete: boolean
  hidden: boolean
  onClose: () => void
  children: ReactNode
}) {
  const { role } = useIdentity()
  const preferenceKey = `aftersales:desk-view:v1:${role}`
  const [view, setView] = useState('debug')
  const [following, setFollowing] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // 持久化调用包含完整参数 不再把流式片段展示为独立待执行任务
  const nodes = useMemo(
    () => projectTimeline(events.filter((event) => event.type !== 'tool.input.delta')),
    [events],
  )
  const stats = useMemo(
    () => ({
      steps: events.filter((event) => event.type === 'step.started').length,
      tools: events.filter((event) => event.type === 'tool.requested').length,
      turns: events.filter((event) => event.type === 'agent.turn').length,
    }),
    [events],
  )

  useEffect(() => {
    try {
      const saved = localStorage.getItem(preferenceKey)
      if (saved === 'business' || saved === 'debug') setView(saved)
    } catch {
      /* 存储受限时保留默认视图 */
    }
  }, [preferenceKey])

  useEffect(() => {
    if (followRef.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [events, view, hidden])

  return (
    <aside className="desk-agent" hidden={hidden} aria-label="Agent 执行面板">
      <header className="desk-agent-heading">
        <h2>Agent 执行面板</h2>
        <StatusBadge status={status} />
        <Button variant="ghost" size="icon-sm" aria-label="收起 Agent 面板" onClick={onClose}>
          <PanelRightClose />
        </Button>
      </header>
      <div className="desk-agent-stats" aria-label="执行统计">
        <span>
          步骤<strong>{stats.steps}</strong>
        </span>
        <span>
          工具调用<strong>{stats.tools}</strong>
        </span>
        <span>
          模型轮次<strong>{stats.turns}</strong>
        </span>
        <span>
          事件流<strong>{complete ? '已同步' : connected ? '已连接' : '重连中'}</strong>
        </span>
      </div>
      <Tabs
        value={view}
        className="desk-agent-tabs"
        onValueChange={(value) => {
          setView(value)
          try {
            localStorage.setItem(preferenceKey, value)
          } catch {
            /* 存储受限不影响切换 */
          }
        }}
      >
        <TabsList variant="line" aria-label="Agent 面板视图">
          <TabsTrigger value="business">业务视图</TabsTrigger>
          <TabsTrigger value="debug">调试视图</TabsTrigger>
        </TabsList>
        <TabsContent value="business" className="desk-business">
          {children}
        </TabsContent>
        <TabsContent value="debug" className="desk-debug">
          <div
            ref={scroll}
            className="desk-event-scroll"
            onScroll={(event) => {
              const target = event.currentTarget
              const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 40
              followRef.current = nearBottom
              setFollowing(nearBottom)
            }}
          >
            {!nodes.length && (
              <DeskEmpty title="尚无执行事件" description="实际执行后将在这里展示步骤与工具记录" />
            )}
            <ol className="desk-timeline">
              {nodes.map((node) => (
                <li key={node.key} className="desk-event" data-status={node.status}>
                  <time dateTime={node.events[0]?.createdAt}>
                    {node.events[0]
                      ? new Date(node.events[0].createdAt).toLocaleTimeString('zh-CN', {
                          hour12: false,
                        })
                      : ''}
                  </time>
                  <div className="desk-event-body">
                    <header>
                      <strong>{node.label}</strong>
                      {node.status && (
                        <span className="desk-event-status">
                          {node.status === 'succeeded'
                            ? '调用成功'
                            : node.status === 'failed'
                              ? '调用失败'
                              : '执行中'}
                        </span>
                      )}
                    </header>
                    <p>
                      {timelineHint(node)}
                      {node.latencyMs !== undefined ? ` · ${node.latencyMs} ms` : ''}
                    </p>
                    <details open>
                      <summary>参数与结果</summary>
                      {node.events
                        .filter(
                          (event) =>
                            event.type !== 'tool.input.delta' && event.type !== 'message.delta',
                        )
                        .map((event) => (
                          <div key={event.sequence}>
                            <small>{event.type}</small>
                            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                          </div>
                        ))}
                      {node.inputFrames?.length ? <pre>{node.inputFrames.join('')}</pre> : null}
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          {!following && (
            <Button
              className="desk-follow"
              variant="outline"
              size="sm"
              onClick={() => {
                followRef.current = true
                setFollowing(true)
                if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
              }}
            >
              <ArrowDown />
              回到最新
            </Button>
          )}
        </TabsContent>
      </Tabs>
      <footer className="desk-agent-footer">
        <NavigationLink href={`/runs/${encodeURIComponent(runId)}`}>
          查看完整运行记录
        </NavigationLink>
      </footer>
    </aside>
  )
}
