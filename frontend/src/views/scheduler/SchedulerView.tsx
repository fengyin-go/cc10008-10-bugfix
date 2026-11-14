import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction } from '@/api/local-service'
import { batchRetryableNodes, loadPipelineWorkbench, retryPipelineBatch, retryPipelineNode } from '@/api/pipeline-service'
import type { BatchActionResult, EntryRow, PipelineWorkbench } from '@/data/types'

const meta = moduleMeta('scheduler')
const columns = [
  "配置编号",
  "关联任务",
  "调度表达式",
  "时区设定",
  "前置任务",
  "最大并发数",
  "失败重试策略",
  "超时终止"
]
const scheduleActions = meta.actions

function fmtTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export default function SchedulerView() {
  const [workbench, setWorkbench] = useState<PipelineWorkbench | null>(null)
  const [schedules, setSchedules] = useState<EntryRow[]>([])
  const [scheduleTotal, setScheduleTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [lastResult, setLastResult] = useState<BatchActionResult | null>(null)
  const [activeBatch, setActiveBatch] = useState<string>('')
  const [rowMessage, setRowMessage] = useState('')

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      // 运行记录先落盘再列配置，失败区间和配置列表引用同一份状态。
      setWorkbench(loadPipelineWorkbench())
      const schedulePayload = listEntries(meta.key)
      setSchedules(schedulePayload.items)
      setScheduleTotal(schedulePayload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '调度管理列表读取失败')
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const nodes = workbench?.nodes ?? []
  const batches = workbench?.batches ?? []
  const failures = workbench?.failures ?? []
  const receipts = workbench?.receipts ?? []

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.batchId === activeBatch) ?? null,
    [batches, activeBatch],
  )

  const batchFailures = useMemo(() => {
    if (!selectedBatch) {
      return failures
    }
    return failures.filter((failure) => failure.batchId === selectedBatch.batchId)
  }, [failures, selectedBatch])

  const currentExecutionIds = useMemo(
    () => new Set(nodes.filter((node) => node.status === '已失败').map((node) => node.currentExecutionId)),
    [nodes],
  )

  const stats = workbench ? [
    { label: '调度配置总数', value: nodes.length },
    { label: '运行中节点', value: workbench.stats.running },
    { label: '可重试节点', value: workbench.stats.retryable },
    { label: '当前失败区间', value: workbench.stats.currentFailureIntervals },
    { label: '历史失败区间', value: workbench.stats.historicalFailureIntervals },
  ] : []

  function retryBatch(batchId: string) {
    setErrorMessage('')
    setInfoMessage('')
    try {
      const result = retryPipelineBatch(batchId)
      setLastResult(result)
      if (result.ok) {
        setInfoMessage(result.message)
      } else {
        setErrorMessage(result.failures.map((item) => `${item.code}：${item.message}`).join('；') || result.message)
      }
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重试批次失败')
    }
  }

  function retryNode(nodeId: number) {
    setActiveBatch('')
    setErrorMessage('')
    setInfoMessage('')
    try {
      const result = retryPipelineNode(nodeId)
      setLastResult(result)
      if (result.ok) {
        setInfoMessage(result.message)
      } else {
        setErrorMessage(result.failures.map((item) => `${item.code}：${item.message}`).join('；') || result.message)
      }
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重试节点失败')
    }
  }

  function runScheduleAction(action: string, id: number) {
    setRowMessage('')
    const result = runAction(meta.key, id, action)
    setRowMessage(result.ok ? result.message : `失败：${result.message}`)
    reload()
  }

  return (
    <section className="page" data-module="scheduler">
      <header className="page-head">
        <div>
          <h2>调度管理</h2>
          <p className="page-desc">维护调度配置的输入、执行约束与结果记录，为任务编排调度提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('调度配置登记入口尚未接入审批流')}>
            登记调度配置
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出调度管理清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <h3 className="section-title">调度配置</h3>
      <table className="data-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>当前状态</th><th>可执行动作</th></tr>
        </thead>
        <tbody>
          {schedules.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {scheduleActions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runScheduleAction(action, Number(row.id))}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {schedules.length === 0 && (
            <tr><td className="empty-state" colSpan={columns.length + 2}>暂无调度配置，可先登记调度配置</td></tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">运行批次</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>批次</th><th>波次</th><th>触发来源</th><th>节点数</th><th>批次状态</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const incomplete = batchRetryableNodes(batch.batchId)
            return (
              <tr key={batch.batchId}>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={() => setActiveBatch(batch.batchId === activeBatch ? '' : batch.batchId)}
                  >
                    {batch.batchId}
                  </button>
                </td>
                <td>{batch.wave}</td>
                <td>{batch.trigger}{batch.parentBatchId ? `（重试 ${batch.parentBatchId}）` : ''}</td>
                <td>{batch.nodeIds.length}</td>
                <td>{batch.status}</td>
                <td>{fmtTime(batch.createdAt)}</td>
                <td>
                  <button className="link" type="button" onClick={() => retryBatch(batch.batchId)}>
                    重试未完成节点（{incomplete.length}）
                  </button>
                </td>
              </tr>
            )
          })}
          {batches.length === 0 && (
            <tr><td className="empty-state" colSpan={7}>暂无运行批次，先在分析流水线里启动节点</td></tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">失败区间（按执行记录，重跑不清空）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>节点</th><th>执行编号</th><th>批次</th><th>版本/尝试</th><th>区间</th><th>失败原因</th><th>本执行供数</th><th>性质</th>
          </tr>
        </thead>
        <tbody>
          {batchFailures.map((failure) => {
            const isCurrent = currentExecutionIds.has(failure.executionId)
            return (
              <tr key={failure.executionId}>
                <td>{failure.nodeCode}</td>
                <td>{failure.executionId}</td>
                <td>{failure.batchId}</td>
                <td>v{failure.version} / 第 {failure.attempt} 次</td>
                <td>{fmtTime(failure.startedAt)} ~ {fmtTime(failure.endedAt)}</td>
                <td>{failure.reason}</td>
                <td className="supply-cell">{failure.supply}</td>
                <td>{isCurrent ? '当前执行' : '历史执行'}</td>
              </tr>
            )
          })}
          {batchFailures.length === 0 && (
            <tr><td className="empty-state" colSpan={8}>当前筛选下没有失败区间；重新运行不会清空历史区间</td></tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">逐条回执</h3>
      <table className="data-table">
        <thead>
          <tr><th>回执</th><th>动作</th><th>批次</th><th>时间</th><th>成功/失败</th><th>明细</th></tr>
        </thead>
        <tbody>
          {receipts.slice(0, 10).map((receipt) => (
            <tr key={receipt.receiptId}>
              <td>{receipt.receiptId}</td>
              <td>{receipt.action}</td>
              <td>{receipt.batchId || '—'}</td>
              <td>{fmtTime(receipt.createdAt)}</td>
              <td>{receipt.items.length - receipt.failures.length} / {receipt.failures.length}</td>
              <td>
                {receipt.items.map((item) => (
                  <div key={`${item.id}-${item.executionId ?? 'none'}-${item.message}`} className={item.ok ? 'receipt-line' : 'receipt-line error-text'}>
                    {item.code}：{item.message}
                  </div>
                ))}
                {receipt.skipped.map((item) => (
                  <div key={`skip-${item.id}-${item.message}`} className="receipt-line muted-text">
                    {item.code}：{item.message}
                  </div>
                ))}
              </td>
            </tr>
          ))}
          {receipts.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>暂无回执</td></tr>
          )}
        </tbody>
      </table>

      {lastResult && (
        <p className={lastResult.failures.length > 0 ? 'error-text' : 'ok-text'}>
          最近一次重试回执 {lastResult.receiptId}：
          {lastResult.failures.length > 0
            ? lastResult.failures.map((item) => `${item.code} ${item.message}`).join('；')
            : lastResult.message}
        </p>
      )}

      <h3 className="section-title">节点状态</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>节点</th><th>类型</th><th>状态</th><th>当前执行</th><th>波次</th><th>归档版本</th><th>失败区间（当前/历史）</th><th>阻塞条件</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id}>
              <td>{node.code}</td>
              <td>{node.type}</td>
              <td>{node.status}</td>
              <td>{node.currentExecutionId ?? '—'}</td>
              <td>{node.currentWave ?? '—'}</td>
              <td>{node.archivedVersion ? `v${node.archivedVersion}` : '—'}</td>
              <td>{node.currentFailureCount} / {node.historicalFailureCount}（共 {node.failureCount}）</td>
              <td className="blocker-cell">
                {node.startBlockers.length === 0 && node.archiveBlockers.length === 0
                  ? '—'
                  : [...node.startBlockers, ...node.archiveBlockers].map((item, index) => <div key={`${index}-${item}`}>{item}</div>)}
              </td>
              <td>
                {node.retryable && node.currentBatchId ? (
                  <button className="link" type="button" onClick={() => retryNode(node.id)}>
                    重试本节点
                  </button>
                ) : '—'}
              </td>
            </tr>
          ))}
          {nodes.length === 0 && (
            <tr><td className="empty-state" colSpan={9}>暂无流水线节点</td></tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {scheduleTotal} 条调度配置，{nodes.length} 个流水线节点</span>
        {rowMessage && <span className={rowMessage.startsWith('失败') ? 'error-text' : 'ok-text'}>{rowMessage}</span>}
        {infoMessage && <span className="ok-text">{infoMessage}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
