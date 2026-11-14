import { SEED_PIPELINE_RUNTIME } from './pipeline-seed'
import { SEED_ROWS } from './seed'
import type { EntryRow, PipelineRuntime } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'interactive-analytics-lab:entries'
const PIPELINE_KEY = 'interactive-analytics-lab:pipeline-runtime'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  if (key === 'pipeline') {
    resetPipelineRuntime()
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function emptyRuntime(): PipelineRuntime {
  return {
    runs: [],
    batches: [],
    receipts: [],
    submissions: [],
    counters: { batch: 0, execution: 0, receipt: 0 },
  }
}

function normalizeRuntime(value: unknown): PipelineRuntime {
  const base = emptyRuntime()
  if (!value || typeof value !== 'object') {
    return base
  }
  const parsed = value as Partial<PipelineRuntime>
  const receipts = Array.isArray(parsed.receipts) ? parsed.receipts : []
  return {
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    batches: Array.isArray(parsed.batches) ? parsed.batches : [],
    receipts: receipts.map((receipt) => {
      const items = Array.isArray(receipt.items) ? receipt.items : []
      return {
        ...receipt,
        items,
        failures: Array.isArray(receipt.failures) ? receipt.failures : items.filter((item) => !item.ok),
        skipped: Array.isArray(receipt.skipped) ? receipt.skipped : [],
        ok: typeof receipt.ok === 'boolean' ? receipt.ok : items.some((item) => item.ok),
      }
    }),
    submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
    counters: {
      batch: Number(parsed.counters?.batch) || 0,
      execution: Number(parsed.counters?.execution) || 0,
      receipt: Number(parsed.counters?.receipt) || 0,
    },
  }
}

let runtimeCache: PipelineRuntime | null = null

/** 老版本 localStorage 里可能还是 PIPE-xxx 的示例行，这批行不该套用新的示例运行记录。 */
function usesCurrentPipelineSeed(): boolean {
  const rows = listRows('pipeline')
  return rows.length > 0 && rows.every((row) => String(row['节点编号'] ?? '').startsWith('PIPL-'))
}

function initialRuntime(): PipelineRuntime {
  return usesCurrentPipelineSeed() ? clone(SEED_PIPELINE_RUNTIME) : emptyRuntime()
}

function readRuntimeFromStorage(): PipelineRuntime {
  const raw = window.localStorage.getItem(PIPELINE_KEY)
  if (!raw) {
    return initialRuntime()
  }
  try {
    return normalizeRuntime(JSON.parse(raw))
  } catch {
    return initialRuntime()
  }
}

/** 流水线运行记录独立存一份，避免和节点行混在一起被重置冲掉。 */
export function pipelineRuntime(): PipelineRuntime {
  if (runtimeCache !== null) {
    return runtimeCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    runtimeCache = initialRuntime()
    return runtimeCache
  }
  runtimeCache = readRuntimeFromStorage()
  return runtimeCache
}

/**
 * 动作执行前强制重新读一遍 localStorage：多标签页或并发点击时，
 * 后到的请求能看到前一次已经写入的归档标记，不会两次都成功。
 */
export function reloadPipelineRuntime(): PipelineRuntime {
  if (typeof window === 'undefined' || !window.localStorage) {
    runtimeCache = initialRuntime()
    return runtimeCache
  }
  runtimeCache = readRuntimeFromStorage()
  return runtimeCache
}

export function savePipelineRuntime(runtime: PipelineRuntime): void {
  runtimeCache = runtime
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PIPELINE_KEY, JSON.stringify(runtime))
  }
}

export function resetPipelineRuntime(): PipelineRuntime {
  const next = clone(SEED_PIPELINE_RUNTIME)
  savePipelineRuntime(next)
  return next
}
