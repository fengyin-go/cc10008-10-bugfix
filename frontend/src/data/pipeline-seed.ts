import type { PipelineRuntime } from './types'

/**
 * 首次打开时的流水线历史：一个已经跑过一波的批次。
 * 1 号节点故意没有执行记录：点「归档结果」会被拒绝（未执行不能归档）。
 * 2 号节点已完成、3 号节点失败——失败区间挂在它自己的执行上，
 * 调度工作台能直接看到“哪一次执行、哪个版本、哪次尝试”产生了这段区间。
 * 2 号节点已完成，重试会跳过它并保持原波次；4 号节点的只读输出目标用来验证开始前拒绝。
 */
export const SEED_PIPELINE_RUNTIME: PipelineRuntime = {
  counters: { batch: 1, execution: 2, receipt: 1 },
  submissions: [
    { nodeId: 2, at: '2026-11-12T23:31:00.000Z', fromStatus: '草稿' },
    { nodeId: 3, at: '2026-11-12T23:32:00.000Z', fromStatus: '草稿' },
  ],
  batches: [
    {
      batchId: 'BATCH-0001',
      nodeIds: [2, 3],
      status: '部分失败',
      wave: 1,
      createdAt: '2026-11-13T02:00:00.000Z',
      updatedAt: '2026-11-13T02:12:00.000Z',
      parentBatchId: null,
      trigger: '示例批次',
    },
  ],
  runs: [
    {
      executionId: 'EXEC-0001',
      batchId: 'BATCH-0001',
      nodeId: 2,
      nodeCode: 'PIPL-0002',
      attempt: 1,
      version: 1,
      status: '已完成',
      startedAt: '2026-11-13T02:00:00.000Z',
      endedAt: '2026-11-13T02:04:00.000Z',
      archivedAt: '2026-11-13T02:05:00.000Z',
      outputTarget: 'oss://analytics/out/pipl-0002',
      supply: '输入源=dataset:sales_raw；输出目标=oss://analytics/out/pipl-0002；处理脚本=aggregate_sales.sql；版本=v1；第 1 次执行',
      failure: null,
      trigger: '示例批次',
    },
    {
      executionId: 'EXEC-0002',
      batchId: 'BATCH-0001',
      nodeId: 3,
      nodeCode: 'PIPL-0003',
      attempt: 1,
      version: 1,
      status: '已失败',
      startedAt: '2026-11-13T02:09:40.000Z',
      endedAt: '2026-11-13T02:12:00.000Z',
      archivedAt: null,
      outputTarget: 'oss://analytics/out/pipl-0003',
      supply: '输入源=dataset:sales_aggregated；输出目标=oss://analytics/out/pipl-0003；处理脚本=validate_quality.py；版本=v1；第 1 次执行',
      failure: {
        executionId: 'EXEC-0002',
        batchId: 'BATCH-0001',
        nodeId: 3,
        nodeCode: 'PIPL-0003',
        attempt: 1,
        version: 1,
        startedAt: '2026-11-13T02:09:40.000Z',
        endedAt: '2026-11-13T02:12:00.000Z',
        reason: '质量校验脚本超时，节点被终止',
        supply:
          '输入源=dataset:sales_aggregated；输出目标=oss://analytics/out/pipl-0003；处理脚本=validate_quality.py；版本=v1；第 1 次执行',
      },
      trigger: '示例批次',
    },
  ],
  receipts: [
    {
      receiptId: 'RCPT-0001',
      action: '启动运行',
      batchId: 'BATCH-0001',
      createdAt: '2026-11-13T02:00:00.000Z',
      ok: true,
      items: [
        { id: 2, code: 'PIPL-0002', ok: true, message: '已启动 EXEC-0001', status: '运行中', executionId: 'EXEC-0001', batchId: 'BATCH-0001', version: 1, attempt: 1 },
        { id: 3, code: 'PIPL-0003', ok: true, message: '已启动 EXEC-0002', status: '运行中', executionId: 'EXEC-0002', batchId: 'BATCH-0001', version: 1, attempt: 1 },
      ],
      failures: [],
      skipped: [],
    },
  ],
}
