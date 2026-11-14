/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/**
 * 流水线运行记录。
 *
 * 节点行只保存“当前状态”，一次执行（运行批次 + 执行编号）产生的失败区间、
 * 版本、供数都落在运行记录里。这样终止、重新运行、重试都不会覆盖旧记录。
 */
export type PipelineRunStatus = '运行中' | '已完成' | '已失败' | '已中断'

export type PipelineBatchStatus = '待调度' | '运行中' | '已完成' | '已中断' | '部分失败'

export type FailureInterval = {
  executionId: string
  batchId: string
  nodeId: number
  nodeCode: string
  attempt: number
  version: number
  startedAt: string
  endedAt: string
  reason: string
  /** 本次执行自己的供数快照，不能从上一批次继承。 */
  supply: string
}

export type PipelineRun = {
  executionId: string
  batchId: string
  nodeId: number
  nodeCode: string
  attempt: number
  version: number
  status: PipelineRunStatus
  startedAt: string
  endedAt: string | null
  archivedAt: string | null
  outputTarget: string
  supply: string
  failure: FailureInterval | null
  trigger: string
}

export type PipelineBatch = {
  batchId: string
  nodeIds: number[]
  status: PipelineBatchStatus
  wave: number
  createdAt: string
  updatedAt: string
  parentBatchId: string | null
  trigger: string
}

export type BatchReceiptItem = {
  id: number
  code: string
  ok: boolean
  message: string
  status: string
  executionId?: string
  batchId?: string
  version?: number
  attempt?: number
  supply?: string
  blockers?: string[]
}

export type BatchReceipt = {
  receiptId: string
  action: string
  batchId: string
  createdAt: string
  ok: boolean
  items: BatchReceiptItem[]
  failures: BatchReceiptItem[]
  /** 明确跳过的节点（例如已完成、保持原波次），不算成功也不算批内失败。 */
  skipped: BatchReceiptItem[]
}

export type BatchActionResult = {
  ok: boolean
  message: string
  action: string
  receiptId: string
  batchId: string
  results: BatchReceiptItem[]
  failures: BatchReceiptItem[]
  skipped: BatchReceiptItem[]
}

export type PipelineSubmission = {
  nodeId: number
  at: string
  fromStatus: string
}

export type PipelineRuntime = {
  runs: PipelineRun[]
  batches: PipelineBatch[]
  receipts: BatchReceipt[]
  submissions: PipelineSubmission[]
  counters: { batch: number; execution: number; receipt: number }
}

export type PipelineNodeInfo = {
  id: number
  code: string
  type: string
  status: string
  version: number | null
  attempt: number | null
  currentBatchId: string | null
  currentExecutionId: string | null
  currentWave: number | null
  currentStartedAt: string | null
  retryable: boolean
  archivedVersion: number | null
  /** 当前这次执行是否处于失败态；历史失败单独计数，不算到本次。 */
  currentFailure: boolean
  failureCount: number
  currentFailureCount: number
  historicalFailureCount: number
  startBlockers: string[]
  archiveBlockers: string[]
}

export type PipelineWorkbench = {
  nodes: PipelineNodeInfo[]
  runs: PipelineRun[]
  failures: FailureInterval[]
  batches: PipelineBatch[]
  receipts: BatchReceipt[]
  stats: {
    total: number
    running: number
    completed: number
    failed: number
    retryable: number
    failureIntervals: number
    currentFailureIntervals: number
    historicalFailureIntervals: number
  }
}
