import { listRows, reloadPipelineRuntime, savePipelineRuntime, saveRows } from '@/data/local-store'
import type {
  BatchActionResult,
  BatchReceipt,
  BatchReceiptItem,
  EntryRow,
  FailureInterval,
  PipelineBatch,
  PipelineBatchStatus,
  PipelineNodeInfo,
  PipelineRun,
  PipelineRuntime,
  PipelineWorkbench,
} from '@/data/types'

/**
 * 分析流水线的运行时模型。
 *
 * 节点行只保存“当前状态”，凡是带“哪一次执行”的信息一律进运行记录：
 * - 一个运行批次（batch）是一波执行；
 * - 一次执行（execution）对应批次里的一个节点，带 attempt / version；
 * - 失败区间挂在执行上，永远不删，重新运行也不会覆盖；
 * - 批量操作每次返回逐条回执，批内失败单独列出。
 */

const MODULE = 'pipeline'
const CODE = '节点编号'
const OUTPUT = '输出目标'
const DEPENDENCY = '依赖上游'

const STATUS_DRAFT = '草稿'
const STATUS_PENDING = '待调度'
const STATUS_RUNNING = '运行中'
const STATUS_DONE = '已完成'
const STATUS_FAILED = '已失败'

const ACTION_SUBMIT = '提交调度'
const ACTION_START = '启动运行'
const ACTION_FINISH = '完成运行'
const ACTION_TERMINATE = '终止运行'
const ACTION_ARCHIVE = '归档结果'

const ACTIONS = [ACTION_SUBMIT, ACTION_START, ACTION_FINISH, ACTION_TERMINATE, ACTION_ARCHIVE]

/** 同一次点击里对同一节点的归档只能成功一次：同步入口也做在途互斥。 */
const inFlight = new Set<string>()

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧的流水线行可能还是 PIPE-xxx 示例；运行记录里的批次/执行引用的却是 PIPL-xxx。
// 这类孤儿记录必须丢弃，否则列表和调度工作台会显示相互矛盾的状态。
function codeOfRow(row: EntryRow): string {
  return String(row[CODE] ?? `PIPL-${pad(Number(row.id))}`)
}

function pruneOrphanRuntime(data: PipelineRuntime, rows: EntryRow[]): PipelineRuntime {
  const knownCodes = new Set(rows.map(codeOfRow))
  const knownIds = new Set(rows.map((row) => Number(row.id)))
  const runs = data.runs.filter((run) => knownIds.has(run.nodeId) && knownCodes.has(run.nodeCode))
  const batches = data.batches.filter((batch) =>
    batch.nodeIds.some((nodeId) => knownIds.has(nodeId)) &&
    runs.some((run) => run.batchId === batch.batchId),
  )
  const batchIds = new Set(batches.map((batch) => batch.batchId))
  const prunedRuns = runs.filter((run) => batchIds.has(run.batchId))
  return {
    ...data,
    runs: prunedRuns,
    batches,
    receipts: data.receipts.filter((receipt) =>
      !receipt.batchId || batchIds.has(receipt.batchId) || receipt.items.every((item) => knownIds.has(item.id)),
    ),
    submissions: data.submissions.filter((item) => knownIds.has(item.nodeId)),
  }
}

function pad(value: number): string {
  return String(value).padStart(4, '0')
}

function nodeCode(row: EntryRow): string {
  return String(row[CODE] ?? `PIPL-${pad(Number(row.id))}`)
}

function runtime(): PipelineRuntime {
  const rows = listRows(MODULE)
  return clone(pruneOrphanRuntime(reloadPipelineRuntime(), rows))
}

function nextId(kind: 'batch' | 'execution' | 'receipt', data: PipelineRuntime): string {
  data.counters[kind] += 1
  const prefixes = { batch: 'BATCH', execution: 'EXEC', receipt: 'RCPT' } as const
  return `${prefixes[kind]}-${pad(data.counters[kind])}`
}

function dependencyCodes(row: EntryRow): string[] {
  const raw = String(row[DEPENDENCY] ?? '').trim()
  if (!raw || raw === '无' || raw === '—' || raw === '-') {
    return []
  }
  return raw
    .split(/[,，;；、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '' && item !== '无' && item !== '—')
}

/** 输出目标是否可写。不可写的目标在节点开始前就要拒绝，不能先建执行再失败。 */
export function isWritableTarget(target: string): boolean {
  const value = target.trim()
  if (!value || value === '—' || value === '-') {
    return false
  }
  if (/^readonly:\/\//i.test(value)) {
    return false
  }
  if (/(^|[/_-])ro([/_-]|$)/i.test(value)) {
    return false
  }
  return !value.includes('只读')
}

function latestRunOf(nodeId: number, data: PipelineRuntime): PipelineRun | null {
  const runs = data.runs.filter((run) => run.nodeId === nodeId)
  if (runs.length === 0) {
    return null
  }
  return runs[runs.length - 1]
}

function latestBatchOf(nodeId: number, data: PipelineRuntime): PipelineBatch | null {
  const run = latestRunOf(nodeId, data)
  if (!run) {
    return null
  }
  return data.batches.find((batch) => batch.batchId === run.batchId) ?? null
}

function runStatusToNodeStatus(run: PipelineRun): string {
  if (run.status === '运行中') {
    return STATUS_RUNNING
  }
  if (run.status === '已完成') {
    return STATUS_DONE
  }
  return STATUS_FAILED
}

/**
 * 节点当前状态完全由运行记录推导：
 * 没有执行记录的节点只会是草稿/待调度；旧版本残留的“运行中”不会变成幽灵状态。
 */
function derivedStatus(row: EntryRow, data: PipelineRuntime): string {
  const run = latestRunOf(Number(row.id), data)
  if (run) {
    return runStatusToNodeStatus(run)
  }
  // 没有执行记录的遗留行：草稿/待调度原样保留，真实失败和完成也不能被静默抹掉；
  // 只有旧版本残留的“运行中”会因为没有执行支撑而回到待调度。
  const current = String(row.status)
  if (current === STATUS_FAILED || current === STATUS_DONE || current === STATUS_DRAFT) {
    return current
  }
  return STATUS_PENDING
}

function codeToRow(rows: EntryRow[], code: string): EntryRow | undefined {
  return rows.find((row) => nodeCode(row) === code)
}

/** 依赖上游必须全部“已完成”，否则给出具体是哪一个节点、当前是什么状态。 */
function dependencyBlockers(row: EntryRow, rows: EntryRow[], data: PipelineRuntime): string[] {
  const blockers: string[] = []
  for (const code of dependencyCodes(row)) {
    const upstream = codeToRow(rows, code)
    if (!upstream) {
      blockers.push(`依赖上游 ${code} 未登记，无法确认完成状态`)
      continue
    }
    const status = derivedStatus(upstream, data)
    if (status !== STATUS_DONE) {
      blockers.push(`依赖上游 ${code} 当前状态「${status}」，尚未完成`)
    }
  }
  return blockers
}

function statusBlockers(row: EntryRow, action: string, data: PipelineRuntime): string[] {
  const run = latestRunOf(Number(row.id), data)
  const status = derivedStatus(row, data)
  switch (action) {
    case ACTION_SUBMIT:
      if (status === STATUS_DRAFT) {
        return []
      }
      if (status === STATUS_FAILED) {
        return ['节点已失败，失败区间已保留；请直接「启动运行」重试，不要回退到待调度']
      }
      return status === STATUS_PENDING
        ? ['节点已经处于「待调度」，不用重复提交']
        : [`节点当前状态「${status}」，不能重新提交调度`]
    case ACTION_START:
      if (status === STATUS_RUNNING) {
        return ['节点正在运行中，不能重复启动']
      }
      if (status === STATUS_DONE) {
        if (!run) {
          // 旧版本留下的已完成行没有执行明细，无法判断归档状态；按已归档处理，重跑生成新记录。
          return []
        }
        if (!run.archivedAt) {
          return ['本次结果尚未归档，不能重新运行；归档后再次启动会生成新版本']
        }
        return []
      }
      if (status === STATUS_PENDING || status === STATUS_FAILED) {
        return []
      }
      return ['节点尚未提交调度，请先执行「提交调度」']
    case ACTION_FINISH:
      return status === STATUS_RUNNING ? [] : [`节点当前状态「${status}」，只有运行中的节点可以标记完成`]
    case ACTION_TERMINATE:
      return status === STATUS_RUNNING ? [] : [`节点当前状态「${status}」，只有运行中的节点可以终止`]
    case ACTION_ARCHIVE:
      if (!run) {
        return status === STATUS_DONE
          ? ['该结果没有执行记录（旧版本遗留），视为已归档，无需再操作']
          : ['节点尚未执行，未产生可归档的结果']
      }
      if (status === STATUS_RUNNING) {
        return ['节点仍在运行，结果尚未完成，不能归档']
      }
      if (status === STATUS_FAILED) {
        return ['节点运行失败，没有可归档的成功结果']
      }
      if (run.archivedAt) {
        return [`该结果已于 ${run.archivedAt} 归档（版本 v${run.version}），不能重复归档；如需再跑请直接启动新版本`]
      }
      return []
    default:
      return [`流水线节点没有登记「${action}」这个动作`]
  }
}

export function nodeBlockers(row: EntryRow, action: string, data: PipelineRuntime, rows: EntryRow[]): string[] {
  if (!ACTIONS.includes(action)) {
    return [`流水线节点没有登记「${action}」这个动作`]
  }
  const blockers = statusBlockers(row, action, data)
  // 启动和归档都受依赖上游约束；归档按钮即使可见，也要说明到底被谁阻塞。
  if (action === ACTION_START || action === ACTION_ARCHIVE) {
    blockers.push(...dependencyBlockers(row, rows, data))
  }
  if (action === ACTION_START) {
    const target = String(row[OUTPUT] ?? '')
    if (!isWritableTarget(target)) {
      blockers.push(`输出目标「${target || '（空）'}」不可写，已在节点开始前拒绝运行`)
    }
  }
  return blockers
}

function refreshBatchStatus(data: PipelineRuntime, batchId: string): void {
  const batch = data.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return
  }
  const runs = data.runs.filter((run) => run.batchId === batchId)
  if (runs.length === 0) {
    return
  }
  let status: PipelineBatchStatus = batch.status
  const running = runs.some((run) => run.status === '运行中')
  const interrupted = runs.some((run) => run.status === '已中断')
  const failed = runs.some((run) => run.status === '已失败')
  const allDone = runs.every((run) => run.status === '已完成')
  if (running) {
    status = '运行中'
  } else if (allDone) {
    status = '已完成'
  } else if (interrupted) {
    status = '已中断'
  } else if (failed) {
    status = '部分失败'
  }
  batch.status = status
  batch.updatedAt = now()
}

/** 把运行记录回写到节点行：状态、待办、异常标记都以“本次执行”为准。 */
function syncRows(data: PipelineRuntime): EntryRow[] {
  const rows = listRows(MODULE)
  let changed = false
  const next = rows.map((row) => {
    const status = derivedStatus(row, data)
    const pending = status !== STATUS_DONE
    const abnormal = status === STATUS_FAILED
    if (String(row.status) === status && row.pending === pending && row.abnormal === abnormal) {
      return row
    }
    changed = true
    return { ...row, status, pending, abnormal }
  })
  if (changed) {
    saveRows(MODULE, next)
  }
  return next
}

function supplySnapshot(row: EntryRow, version: number, attempt: number): string {
  const input = String(row['输入源'] ?? '—')
  const output = String(row[OUTPUT] ?? '—')
  const script = String(row['处理脚本'] ?? '—')
  return `输入源=${input}；输出目标=${output}；处理脚本=${script}；版本=v${version}；第 ${attempt} 次执行`
}

function pushFailure(
  data: PipelineRuntime,
  run: PipelineRun,
  reason: string,
  endedAt: string,
): FailureInterval {
  const failure: FailureInterval = {
    executionId: run.executionId,
    batchId: run.batchId,
    nodeId: run.nodeId,
    nodeCode: run.nodeCode,
    attempt: run.attempt,
    version: run.version,
    startedAt: run.startedAt,
    endedAt,
    reason,
    // 每次执行在启动时就固定自己的供数；失败回执只引用本次执行的快照。
    supply: run.supply,
  }
  run.failure = failure
  return failure
}

function receiptItem(
  row: EntryRow,
  ok: boolean,
  message: string,
  run?: PipelineRun,
  blockers?: string[],
): BatchReceiptItem {
  return {
    id: Number(row.id),
    code: nodeCode(row),
    ok,
    message,
    status: String(row.status),
    executionId: run?.executionId,
    batchId: run?.batchId,
    version: run?.version,
    attempt: run?.attempt,
    supply: run?.supply,
    blockers,
  }
}

function saveReceipt(data: PipelineRuntime, receipt: BatchReceipt): void {
  data.receipts = [receipt, ...data.receipts].slice(0, 100)
}

function applySingle(
  data: PipelineRuntime,
  row: EntryRow,
  action: string,
  rows: EntryRow[],
): BatchReceiptItem {
  const blockers = nodeBlockers(row, action, data, rows)
  if (blockers.length > 0) {
    return receiptItem(row, false, blockers.join('；'), latestRunOf(Number(row.id), data) ?? undefined, blockers)
  }

  const run = latestRunOf(Number(row.id), data)
  const stamp = now()
  const before = derivedStatus(row, data)

  if (action === ACTION_SUBMIT) {
    row.status = STATUS_PENDING
    data.submissions = data.submissions.filter((item) => item.nodeId !== Number(row.id))
    data.submissions.push({ nodeId: Number(row.id), at: stamp, fromStatus: before })
    return receiptItem(row, true, `已提交调度（原状态「${before}」），当前状态「待调度」`)
  }

  if (action === ACTION_FINISH) {
    if (!run) {
      return receiptItem(row, false, '没有正在运行的执行记录')
    }
    run.status = '已完成'
    run.endedAt = stamp
    row.status = STATUS_DONE
    refreshBatchStatus(data, run.batchId)
    return receiptItem(row, true, `执行 ${run.executionId} 已完成，等待归档`, run)
  }

  if (action === ACTION_TERMINATE) {
    if (!run) {
      return receiptItem(row, false, '没有正在运行的执行记录')
    }
    run.status = '已中断'
    run.endedAt = stamp
    const failure = pushFailure(data, run, '手动终止运行', stamp)
    row.status = STATUS_FAILED
    refreshBatchStatus(data, run.batchId)
    return receiptItem(
      row,
      true,
      `已终止执行 ${run.executionId}，失败区间 ${failure.startedAt} ~ ${failure.endedAt} 已保留`,
      run,
    )
  }

  if (action === ACTION_ARCHIVE) {
    if (!run) {
      return receiptItem(row, false, '节点尚未执行，未产生可归档的结果')
    }
    const lockKey = `${row.id}:archive`
    if (inFlight.has(lockKey)) {
      return receiptItem(row, false, '该节点的归档操作正在进行中，本次请求未重复执行', run)
    }
    inFlight.add(lockKey)
    try {
      if (run.archivedAt) {
        return receiptItem(row, false, `版本 v${run.version} 已归档，不能重复归档`, run)
      }
      run.archivedAt = stamp
      row.status = STATUS_DONE
      return receiptItem(row, true, `执行 ${run.executionId} 已归档，版本 v${run.version}`, run)
    } finally {
      inFlight.delete(lockKey)
    }
  }

  return receiptItem(row, false, `流水线节点没有登记「${action}」这个动作`)
}

function buildBatch(
  data: PipelineRuntime,
  nodeIds: number[],
  retryOf: PipelineBatch | null,
  trigger: string,
): PipelineBatch {
  const maxWave = data.batches.reduce((max, batch) => Math.max(max, batch.wave), 0)
  const stamp = now()
  const batch: PipelineBatch = {
    batchId: nextId('batch', data),
    nodeIds: [...nodeIds],
    status: '运行中',
    wave: retryOf ? retryOf.wave : maxWave + 1,
    createdAt: stamp,
    updatedAt: stamp,
    parentBatchId: retryOf ? retryOf.batchId : null,
    trigger: retryOf ? `中断重试（源批次 ${retryOf.batchId}）` : trigger,
  }
  data.batches.push(batch)
  return batch
}

/**
 * 启动一批节点。
 * - 普通启动：新批次、波次 +1；
 * - 失败/中断后的重试：只启动未完成节点，波次沿用被重试批次，已完成节点不进入新批次。
 */
function startNodes(
  data: PipelineRuntime,
  rows: EntryRow[],
  targets: EntryRow[],
  trigger: string,
  retryOf: PipelineBatch | null,
): { batchId: string; items: BatchReceiptItem[] } {
  const items: BatchReceiptItem[] = []
  const candidates: { row: EntryRow; run: PipelineRun | null }[] = []

  for (const row of targets) {
    const blockers = nodeBlockers(row, ACTION_START, data, rows)
    if (blockers.length > 0) {
      items.push(receiptItem(row, false, blockers.join('；'), latestRunOf(Number(row.id), data) ?? undefined, blockers))
      continue
    }
    candidates.push({ row, run: latestRunOf(Number(row.id), data) })
  }

  if (candidates.length === 0) {
    return { batchId: '', items }
  }

  // 只有调度工作台明确的“重试”才会传入 retryOf，沿用原波次；
  // 页面上的普通启动（包括终止后再启动）一律新开批次、波次 +1。
  const batch = buildBatch(
    data,
    candidates.map((item) => item.row.id),
    retryOf,
    trigger,
  )

  for (const { row, run: previous } of candidates) {
    const status = derivedStatus(row, data)
    const version = previous ? (status === STATUS_DONE ? previous.version + 1 : previous.version) : 1
    const attempt = previous ? (status === STATUS_DONE ? 1 : previous.attempt + 1) : 1
    const execution: PipelineRun = {
      executionId: nextId('execution', data),
      batchId: batch.batchId,
      nodeId: Number(row.id),
      nodeCode: nodeCode(row),
      attempt,
      version,
      status: '运行中',
      startedAt: now(),
      endedAt: null,
      archivedAt: null,
      outputTarget: String(row[OUTPUT] ?? ''),
      supply: '',
      failure: null,
      trigger: batch.trigger,
    }
    execution.supply = supplySnapshot(row, version, attempt)
    data.runs.push(execution)
    row.status = STATUS_RUNNING
    items.push(
      receiptItem(
        row,
        true,
        `已启动 ${execution.executionId}（批次 ${batch.batchId}，波次 ${batch.wave}，版本 v${version}，第 ${attempt} 次执行）`,
        execution,
      ),
    )
  }
  return { batchId: batch.batchId, items }
}

/** 节点行状态由运行记录推导后强制落盘，避免只在内存缓存里改状态。 */
function persistRows(data: PipelineRuntime): EntryRow[] {
  const rows = listRows(MODULE).map((row) => {
    const status = derivedStatus(row, data)
    return {
      ...row,
      status,
      pending: status !== STATUS_DONE,
      abnormal: status === STATUS_FAILED,
    }
  })
  saveRows(MODULE, rows)
  return rows
}

function finalize(action: string, data: PipelineRuntime, receiptId: string, items: BatchReceiptItem[], batchId: string, skipped: BatchReceiptItem[] = []): BatchActionResult {
  const failures = items.filter((item) => !item.ok)
  // 只有整批全部成功才算 ok：批内有失败时页面必须显示失败，不能当成成功。
  const ok = items.length > 0 && failures.length === 0
  const receipt: BatchReceipt = {
    receiptId,
    action,
    batchId,
    createdAt: now(),
    ok,
    items,
    failures,
    skipped,
  }
  saveReceipt(data, receipt)
  savePipelineRuntime(data)
  persistRows(data)
  const message = items.length === 0
    ? `${action}未执行：没有匹配的可操作节点（回执 ${receiptId}）`
    : failures.length === 0
      ? `${action}成功：${items.length} 条全部成功（回执 ${receiptId}）`
      : failures.length === items.length
        ? `${action}失败：${items.length} 条均未通过，原因见回执 ${receiptId}`
        : `${action}部分成功：成功 ${items.length - failures.length} 条，失败 ${failures.length} 条（回执 ${receiptId}）`
  return { ok, message, action, receiptId, batchId, results: items, failures, skipped }
}

export function runPipelineBatch(
  action: string,
  nodeIds: number[],
  trigger = '手动操作',
  retryOf: PipelineBatch | null = null,
): BatchActionResult {
  const data = runtime()
  const rows = syncRows(data)
  const uniqueIds = [...new Set(nodeIds.map(Number))]
  const receiptId = nextId('receipt', data)
  const targets = uniqueIds
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))

  if (!ACTIONS.includes(action)) {
    return finalize(action, data, receiptId, [], '')
  }
  if (targets.length === 0) {
    return finalize(action, data, receiptId, [], '')
  }

  if (action === ACTION_START) {
    const { batchId, items } = startNodes(data, rows, targets, trigger, retryOf)
    return finalize(action, data, receiptId, items, batchId)
  }

  const items = targets.map((row) => applySingle(data, row, action, rows))
  const batchId = items.find((item) => item.batchId)?.batchId ?? ''
  return finalize(action, data, receiptId, items, batchId)
}

export function runPipelineNodeAction(id: number, action: string): BatchActionResult {
  const result = runPipelineBatch(action, [id])
  // 单条操作时直接把这条的具体原因顶到消息里，页面不用再从回执里翻。
  if (result.results.length === 1) {
    return { ...result, message: result.results[0].message }
  }
  return result
}

/** 批次里可以重试的失败节点：运行中节点跳过，已完成节点留在原波次不重复执行。 */
export function batchRetryableNodes(batchId: string): number[] {
  const data = runtime()
  const batch = data.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return []
  }
  return batch.nodeIds.filter((nodeId) => {
    const latest = latestRunOf(nodeId, data)
    if (!latest) {
      return true
    }
    if (latest.batchId !== batchId) {
      return false
    }
    return latest.status !== '已完成' && latest.status !== '运行中'
  })
}

/** 调度工作台重试：只挑该批次里未完成的节点，已完成节点保持原波次不动。 */
export function retryPipelineBatch(batchId: string): BatchActionResult {
  const data = runtime()
  const batch = data.batches.find((item) => item.batchId === batchId)
  const receiptId = nextId('receipt', data)
  if (!batch) {
    return finalize(ACTION_START, data, receiptId, [], batchId)
  }
  const rows = syncRows(data)
  const candidates: number[] = []
  const skipped: BatchReceiptItem[] = []

  for (const nodeId of batch.nodeIds) {
    const row = rows.find((item) => Number(item.id) === nodeId)
    if (!row) {
      continue
    }
    const latest = latestRunOf(nodeId, data)
    if (latest && latest.batchId !== batchId) {
      // 节点已被后续批次接管，不重复塞进这次重试。
      const note = `${nodeCode(row)} 已在批次 ${latest.batchId} 处理，不在本次重试范围内`
      skipped.push(receiptItem(row, false, note, latest, [note]))
      continue
    }
    if (latest && latest.status === '已完成') {
      // 已完成节点不进入重试批次，仍留在原批次、原波次。
      const note = `${nodeCode(row)} 已在本批完成，保持原波次`
      skipped.push(receiptItem(row, false, note, latest, [note]))
      continue
    }
    if (latest && latest.status === '运行中') {
      const note = `${nodeCode(row)} 正在运行中，跳过本次重试`
      skipped.push(receiptItem(row, false, note, latest, [note]))
      continue
    }
    candidates.push(nodeId)
  }

  if (candidates.length === 0) {
    const first = rows.find((row) => Number(row.id) === batch.nodeIds[0])
    const message = skipped.length > 0
      ? skipped.map((item) => item.message).join('；')
      : `批次 ${batchId} 内所有节点均已完成，无需重试`
    const result = finalize(ACTION_START, data, receiptId, first ? [receiptItem(first, false, message, undefined, [message])] : [], batchId, skipped)
    return { ...result, message }
  }

  // 重试批次沿用源批次的波次；只包含未完成节点，已完成节点不换波次。
  const result = runPipelineBatch(
    ACTION_START,
    candidates,
    `中断重试（源批次 ${batchId}）`,
    batch,
  )
  if (skipped.length === 0) {
    return result
  }
  // 把跳过的节点并进同一条回执，回执里明确区分“本次成功”和“保持原波次”。
  const data2 = runtime()
  const receipt = data2.receipts.find((item) => item.receiptId === result.receiptId)
  if (receipt) {
    receipt.skipped = skipped
  }
  savePipelineRuntime(data2)
  return {
    ...result,
    skipped,
    message: `${result.message}；${skipped.map((item) => item.message).join('；')}`,
  }
}

/** 调度工作台对单个失败节点重试：沿用原批次波次，但不影响同批其他节点。 */
export function retryPipelineNode(nodeId: number): BatchActionResult {
  const data = runtime()
  const run = latestRunOf(nodeId, data)
  const batch = run ? data.batches.find((item) => item.batchId === run.batchId) ?? null : null
  return runPipelineBatch(ACTION_START, [nodeId], `单节点重试（源批次 ${run?.batchId ?? '无'}）`, batch)
}

function nodeInfo(row: EntryRow, rows: EntryRow[], data: PipelineRuntime): PipelineNodeInfo {
  const run = latestRunOf(Number(row.id), data)
  const status = derivedStatus(row, data)
  const batch = latestBatchOf(Number(row.id), data)
  const archived = data.runs
    .filter((item) => item.nodeId === Number(row.id) && item.archivedAt)
    .sort((a, b) => b.version - a.version)[0]
  const failedLike = run?.status === '已失败' || run?.status === '已中断'
  const retryable = failedLike && status === STATUS_FAILED
  const nodeRuns = data.runs.filter((item) => item.nodeId === Number(row.id))
  const startBlockers = nodeBlockers(row, ACTION_START, data, rows)
  const archiveBlockers = nodeBlockers(row, ACTION_ARCHIVE, data, rows)
  return {
    id: Number(row.id),
    code: nodeCode(row),
    type: String(row['节点类型'] ?? ''),
    status,
    version: run?.version ?? null,
    attempt: run?.attempt ?? null,
    currentBatchId: batch?.batchId ?? null,
    currentExecutionId: run?.executionId ?? null,
    currentWave: batch?.wave ?? null,
    currentStartedAt: run?.startedAt ?? null,
    retryable,
    archivedVersion: archived?.version ?? null,
    currentFailure: retryable,
    failureCount: nodeRuns.filter((item) => item.failure).length,
    currentFailureCount: retryable ? 1 : 0,
    historicalFailureCount: retryable ? nodeRuns.filter((item) => item.failure).length - 1 : nodeRuns.filter((item) => item.failure).length,
    startBlockers: [...new Set(startBlockers)],
    archiveBlockers: [...new Set(archiveBlockers)],
  }
}

export function loadPipelineWorkbench(): PipelineWorkbench {
  const data = runtime()
  const rows = syncRows(data)
  const nodes = rows.map((row) => nodeInfo(row, rows, data))
  const failures = data.runs
    .filter((run): run is PipelineRun & { failure: FailureInterval } => Boolean(run.failure))
    .map((run) => run.failure)
    .reverse()
  const batches = [...data.batches].sort((a, b) => b.wave - a.wave)
  const runs = [...data.runs].reverse()
  const currentFailureExecutions = new Set(
    nodes
      .filter((node) => node.status === STATUS_FAILED)
      .map((node) => node.currentExecutionId)
      .filter((value): value is string => Boolean(value)),
  )
  return {
    nodes,
    runs,
    failures,
    batches,
    receipts: data.receipts,
    stats: {
      total: nodes.length,
      running: nodes.filter((node) => node.status === STATUS_RUNNING).length,
      completed: nodes.filter((node) => node.status === STATUS_DONE).length,
      failed: nodes.filter((node) => node.status === STATUS_FAILED).length,
      retryable: nodes.filter((node) => node.retryable).length,
      failureIntervals: failures.length,
      // 只有当次执行仍处于失败态的区间算“当前失败”，其余作为历史保留。
      currentFailureIntervals: failures.filter((failure) => currentFailureExecutions.has(failure.executionId)).length,
      historicalFailureIntervals: failures.filter((failure) => !currentFailureExecutions.has(failure.executionId)).length,
    },
  }
}

/** 同一个节点一次只能有一个运行中的执行；这里给调度工作台做展示用。 */
export function runningExecutions(): PipelineRun[] {
  return runtime().runs.filter((run) => run.status === '运行中')
}
