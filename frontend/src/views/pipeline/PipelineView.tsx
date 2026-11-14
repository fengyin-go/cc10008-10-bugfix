import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  resetModule,
} from '@/api/local-service'
import { loadPipelineWorkbench, runPipelineBatch } from '@/api/pipeline-service'
import type { BatchActionResult, EntryRow, PipelineWorkbench } from '@/data/types'

const meta = moduleMeta('pipeline')
const columns = [
  "节点编号",
  "节点类型",
  "输入源",
  "输出目标",
  "处理脚本",
  "依赖上游",
  "超时秒数",
  "重试次数"
]
const actions = [
  "提交调度",
  "启动运行",
  "完成运行",
  "终止运行",
  "归档结果"
]
const statuses = [
  "草稿",
  "待调度",
  "运行中",
  "已完成",
  "已失败"
]

function fmtTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

export default function PipelineView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [workbench, setWorkbench] = useState<PipelineWorkbench | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<number[]>([])
  const [lastReceipt, setLastReceipt] = useState<BatchActionResult | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      // 先读运行记录并回写节点状态，再列行，列表才不会显示未同步的旧状态。
      setWorkbench(loadPipelineWorkbench())
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setSelected((prev) => prev.filter((id) => payload.items.some((row) => Number(row.id) === id)))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '分析流水线列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const nodeInfo = useMemo(() => {
    const map = new Map<number, PipelineWorkbench['nodes'][number]>()
    for (const node of workbench?.nodes ?? []) {
      map.set(node.id, node)
    }
    return map
  }, [workbench])

  function reportResult(result: BatchActionResult) {
    setLastReceipt(result)
    // 成功与失败分开显示：批内有失败时也必须把失败原因放在显著位置，不能只报成功。
    const succeeded = result.results.length - result.failures.length
    if (result.failures.length === 0) {
      setSuccessMessage(result.message)
      setErrorMessage('')
      return
    }
    setSuccessMessage(succeeded > 0 ? result.message : '')
    setErrorMessage(`批内失败 ${result.failures.length} 条：${result.failures.map((item) => `${item.code}（${item.message}）`).join('；')}`)
  }

  function runAction(action: string, row: EntryRow) {
    setSuccessMessage('')
    setErrorMessage('')
    try {
      const result = runPipelineBatch(action, [Number(row.id)])
      reportResult(result)
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '流水线动作执行失败')
    }
  }

  function runBatchAction(action: string) {
    if (selected.length === 0) {
      setErrorMessage('请先勾选要整组操作的节点')
      return
    }
    setSuccessMessage('')
    setErrorMessage('')
    try {
      const result = runPipelineBatch(action, selected)
      reportResult(result)
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '批量动作执行失败')
    }
  }

  function toggleSelected(id: number) {
    setSelected((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id])
  }

  function toggleAll() {
    setSelected((prev) => prev.length === rows.length ? [] : rows.map((row) => Number(row.id)))
  }

  function resetAll() {
    setErrorMessage('')
    setSuccessMessage('')
    setLastReceipt(null)
    setSelected([])
    resetModule(meta.key)
    reload()
  }

  const statusCounts = (status: string) => rows.filter((row) => String(row.status) === status).length
  const stats = workbench ? [
    { label: '流水线节点总数', value: workbench.stats.total },
    { label: '运行中节点', value: workbench.stats.running },
    { label: '已完成节点', value: workbench.stats.completed },
    { label: '可重试节点', value: workbench.stats.retryable },
    { label: '当前失败区间', value: workbench.stats.currentFailureIntervals },
    { label: '历史失败区间', value: workbench.stats.historicalFailureIntervals },
  ] : []

  return (
    <section className="page" data-module="pipeline">
      <header className="page-head">
        <div>
          <h2>分析流水线管理</h2>
          <p className="page-desc">维护分析流水线节点的输入、执行约束与结果记录，为数据处理编排提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('流水线节点登记入口尚未接入审批流')}>
            登记流水线节点
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出分析流水线清单
          </button>
          <button className="btn ghost" type="button" onClick={resetAll}>
            重置示例数据
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

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{statusCounts(status)}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <div className="batch-bar">
        <span className="muted-text">已勾选 {selected.length} / {rows.length} 个节点，可整组提交为同一批任务：</span>
        {actions.map((action) => (
          <button key={action} className="btn" type="button" onClick={() => runBatchAction(action)}>
            整组{action}
          </button>
        ))}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="全选"
                checked={rows.length > 0 && selected.length === rows.length}
                onChange={toggleAll}
              />
            </th>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>执行/批次</th>
            <th>版本</th>
            <th>阻塞条件</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const info = nodeInfo.get(Number(row.id))
            const blocked = info ? [...info.startBlockers, ...info.archiveBlockers] : []
            return (
              <tr key={String(row.id)}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row['节点编号'] ?? row.id}`}
                    checked={selected.includes(Number(row.id))}
                    onChange={() => toggleSelected(Number(row.id))}
                  />
                </td>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td>
                  <div>{info?.currentExecutionId ?? '—'}</div>
                  <div className="muted-text">{info?.currentBatchId ?? '—'}{info?.currentWave ? ` / 波次 ${info.currentWave}` : ''}</div>
                  {info?.currentStartedAt ? <div className="muted-text">开始 {fmtTime(info.currentStartedAt)}</div> : null}
                </td>
                <td>
                  {info?.version ? `v${info.version}（第 ${info.attempt} 次）` : '—'}
                  {info?.archivedVersion ? <div className="muted-text">已归档 v{info.archivedVersion}</div> : null}
                </td>
                <td className="blocker-cell">
                  {blocked.length === 0 ? '—' : blocked.map((item, index) => <div key={`${index}-${item}`}>{item}</div>)}
                </td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 6}>暂无分析流水线数据，可先登记流水线节点</td>
            </tr>
          )}
        </tbody>
      </table>

      {lastReceipt && <ReceiptPanel receipt={lastReceipt} />}

      <footer className="page-foot">
        <span>共 {total} 条分析流水线记录</span>
        {successMessage && <span className="ok-text">{successMessage}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

function ReceiptPanel({ receipt }: { receipt: BatchActionResult }) {
  const failed = receipt.failures
  return (
    <section className="receipt-panel" aria-label="批量操作回执">
      <header className="receipt-head">
        <strong>批量回执 {receipt.receiptId}</strong>
        <span className="muted-text">
          动作：{receipt.action}　批次：{receipt.batchId || '—'}　成功 {receipt.results.length - receipt.failures.length} 条，失败 {receipt.failures.length} 条
        </span>
      </header>
      <table className="data-table">
        <thead>
          <tr><th>节点</th><th>结果</th><th>说明</th><th>执行编号</th><th>版本/尝试</th></tr>
        </thead>
        <tbody>
          {receipt.results.map((item) => (
            <tr key={`${item.id}-${item.executionId ?? 'none'}`} className={item.ok ? '' : 'row-failed'}>
              <td>{item.code}</td>
              <td>{item.ok ? '成功' : '失败'}</td>
              <td>
                {item.message}
                {item.blockers?.length ? <div className="muted-text">{item.blockers.join('；')}</div> : null}
              </td>
              <td>{item.executionId ?? '—'}</td>
              <td>{item.version ? `v${item.version} / 第 ${item.attempt} 次` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {failed.length > 0 && (
        <p className="error-text">批内失败：{failed.map((item) => `${item.code} ${item.message}`).join('；')}</p>
      )}
      {receipt.skipped.length > 0 && (
        <p className="muted-text">跳过：{receipt.skipped.map((item) => `${item.code} ${item.message}`).join('；')}</p>
      )}
    </section>
  )
}