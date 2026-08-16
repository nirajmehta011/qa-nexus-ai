import aiService, { GenerationAbortedError, type MediaFileData, type SpecInput, type TestCase } from './aiService'
import type { AIProvider } from '../context/SettingsContext'

// Resilience wrapper around the "fast path" (single spec → test cases,
// no requirement-review checkpoint). Generation happens in small batches
// rather than one call for the whole count:
//   1. A single call asking a smaller/faster model for 12 detailed 8-30-step
//      cases is exactly what pushes it past its output budget mid-array,
//      producing truncated JSON the repair pass can't always save.
//   2. Batching gives real checkpoints: a rate limit on batch 3 of 4 doesn't
//      cost batches 1-2, and the same stall/resume/failover UX the deep
//      pipeline already has now applies here too.

export interface FastGenerationProgress {
  status: 'running' | 'done' | 'error'
  detail?: string
}

export interface FastGenerationConfig {
  provider: AIProvider
  apiKey: string
  model: string
  spec: SpecInput
  mediaFiles?: MediaFileData[]
  count: number
  focusInstructions?: string
  signal?: AbortSignal
  onProgress?: (p: FastGenerationProgress) => void
  /** Streamed after every batch so the UI can render cases as they land. */
  onPartialCases?: (cases: TestCase[]) => void
}

const BATCH_SIZE = 4

export interface FastGenerationCheckpoint {
  spec: SpecInput
  mediaFiles?: MediaFileData[]
  count: number
  focusInstructions?: string
  testCases: TestCase[]
  /** Batch index to resume from. */
  nextBatchIndex: number
  totalBatches: number
}

export class FastGenerationStallError extends Error {
  checkpoint: FastGenerationCheckpoint
  constructor(message: string, checkpoint: FastGenerationCheckpoint) {
    super(message)
    this.name = 'FastGenerationStallError'
    this.checkpoint = checkpoint
  }
}

async function runFromCheckpoint(
  cfg: FastGenerationConfig,
  resumeFrom?: { testCases: TestCase[]; nextBatchIndex: number }
): Promise<TestCase[]> {
  const { provider, apiKey, model, spec, mediaFiles, count, focusInstructions, signal, onProgress, onPartialCases } = cfg
  const totalBatches = Math.max(1, Math.ceil(count / BATCH_SIZE))
  let testCases = resumeFrom ? [...resumeFrom.testCases] : []
  const startBatch = resumeFrom?.nextBatchIndex ?? 0

  if (!resumeFrom) {
    onProgress?.({ status: 'running', detail: `planning ${count} test case(s) in ${totalBatches} batch(es)` })
  }

  for (let batch = startBatch; batch < totalBatches; batch++) {
    if (signal?.aborted) throw new GenerationAbortedError()

    const remaining = count - testCases.length
    const thisBatchSize = Math.max(1, Math.min(BATCH_SIZE, remaining))
    onProgress?.({ status: 'running', detail: `batch ${batch + 1}/${totalBatches} — writing ${thisBatchSize} detailed case(s)` })

    try {
      const startIdIndex = testCases.length + 1
      const existingSummaries = testCases.map(tc => `${tc.id} [${tc.scenarioType}]: ${tc.summary}`)
      const batchCases = await aiService.generateTestCaseBatch(
        provider,
        apiKey,
        model,
        spec,
        thisBatchSize,
        startIdIndex,
        existingSummaries,
        focusInstructions,
        // Send attachments once — re-uploading the same images/video on every
        // batch wastes tokens and, for large attachments, risks a payload
        // limit on later batches.
        batch === 0 ? mediaFiles : undefined,
        signal
      )
      testCases = [...testCases, ...batchCases]
      onPartialCases?.(testCases)
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) throw err
      onProgress?.({ status: 'error', detail: 'stalled — pick a model to resume' })
      throw new FastGenerationStallError(err.message || 'Test case generation stalled', {
        spec,
        mediaFiles,
        count,
        focusInstructions,
        testCases,
        nextBatchIndex: batch,
        totalBatches
      })
    }
  }

  // Renumber sequentially – a model occasionally drifts from the requested
  // starting id within a batch.
  testCases = testCases.map((tc, i) => ({ ...tc, id: `TC-${String(i + 1).padStart(3, '0')}` }))
  onProgress?.({ status: 'done', detail: `${testCases.length} test case(s)` })
  return testCases
}

export function generateTestCasesResilient(cfg: FastGenerationConfig): Promise<TestCase[]> {
  return runFromCheckpoint(cfg)
}

export function resumeFastGeneration(
  cfg: Pick<FastGenerationConfig, 'provider' | 'apiKey' | 'model' | 'signal' | 'onProgress' | 'onPartialCases'>,
  checkpoint: FastGenerationCheckpoint
): Promise<TestCase[]> {
  return runFromCheckpoint(
    {
      ...cfg,
      spec: checkpoint.spec,
      mediaFiles: checkpoint.mediaFiles,
      count: checkpoint.count,
      focusInstructions: checkpoint.focusInstructions
    },
    { testCases: checkpoint.testCases, nextBatchIndex: checkpoint.nextBatchIndex }
  )
}
