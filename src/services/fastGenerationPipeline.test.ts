import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./aiService', async () => {
  const actual = await vi.importActual<typeof import('./aiService')>('./aiService')
  return { ...actual, default: { generateTestCaseBatch: vi.fn() } }
})

import aiService from './aiService'
import {
  generateTestCasesResilient,
  resumeFastGeneration,
  FastGenerationStallError
} from './fastGenerationPipeline'
import { GenerationAbortedError, type SpecInput, type TestCase } from './aiService'

const mockBatch = aiService.generateTestCaseBatch as ReturnType<typeof vi.fn>

const spec: SpecInput = {
  key: 'PROJ-1',
  summary: 'Login',
  description: 'Users sign in with email and password.',
  priority: 'High',
  source: 'Pasted text'
}

const makeCases = (ids: string[]): TestCase[] =>
  ids.map(id => ({
    id,
    summary: `case ${id}`,
    issueType: 'Test',
    priority: 'High',
    labels: '',
    testType: 'Functional',
    precondition: '',
    steps: [{ stepNumber: 1, action: 'a', testData: '', expectedResult: 'b' }],
    status: 'Not Executed',
    component: '',
    estimatedTime: '10m',
    scenarioType: 'happy_path'
  }))

beforeEach(() => mockBatch.mockReset())

describe('generateTestCasesResilient', () => {
  it('splits the requested count into small batches and streams partial results', async () => {
    mockBatch
      .mockResolvedValueOnce(makeCases(['TC-001', 'TC-002', 'TC-003', 'TC-004']))
      .mockResolvedValueOnce(makeCases(['TC-005', 'TC-006']))

    const partials: number[] = []
    const result = await generateTestCasesResilient({
      provider: 'gemini',
      apiKey: 'k',
      model: 'm',
      spec,
      count: 6,
      onPartialCases: cases => partials.push(cases.length)
    })

    expect(mockBatch).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(6)
    expect(result.map(c => c.id)).toEqual(['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005', 'TC-006'])
    expect(partials).toEqual([4, 6])

    // Second batch must be told what's already been generated and continue ids from there.
    const secondCallArgs = mockBatch.mock.calls[1]
    expect(secondCallArgs[5]).toBe(5) // startIdIndex
    expect(secondCallArgs[6]).toHaveLength(4) // existingSummaries
  })

  it('sends media attachments only on the first batch', async () => {
    mockBatch
      .mockResolvedValueOnce(makeCases(['TC-001', 'TC-002', 'TC-003', 'TC-004']))
      .mockResolvedValueOnce(makeCases(['TC-005']))

    await generateTestCasesResilient({
      provider: 'gemini',
      apiKey: 'k',
      model: 'm',
      spec,
      count: 5,
      mediaFiles: [{ mimeType: 'image/png', base64: 'xx' }]
    })

    expect(mockBatch.mock.calls[0][8]).toEqual([{ mimeType: 'image/png', base64: 'xx' }])
    expect(mockBatch.mock.calls[1][8]).toBeUndefined()
  })

  it('throws a stall error carrying a resumable checkpoint when a batch fails', async () => {
    mockBatch
      .mockResolvedValueOnce(makeCases(['TC-001', 'TC-002', 'TC-003', 'TC-004']))
      .mockRejectedValueOnce(new Error('Rate limited by gemini. Try again in a moment.'))

    let caught: FastGenerationStallError | undefined
    try {
      await generateTestCasesResilient({ provider: 'gemini', apiKey: 'k', model: 'm', spec, count: 8 })
    } catch (err) {
      caught = err as FastGenerationStallError
    }

    expect(caught).toBeInstanceOf(FastGenerationStallError)
    expect(caught!.checkpoint.testCases).toHaveLength(4) // batch 1's cases are NOT lost
    expect(caught!.checkpoint.nextBatchIndex).toBe(1)
    expect(caught!.checkpoint.count).toBe(8)
  })

  it('propagates a deliberate stop as GenerationAbortedError, not a stall', async () => {
    const controller = new AbortController()
    mockBatch.mockImplementationOnce(async () => {
      controller.abort()
      throw new GenerationAbortedError()
    })

    await expect(
      generateTestCasesResilient({ provider: 'gemini', apiKey: 'k', model: 'm', spec, count: 8, signal: controller.signal })
    ).rejects.toBeInstanceOf(GenerationAbortedError)
  })

  it('checks the abort signal before starting a new batch', async () => {
    const controller = new AbortController()
    mockBatch.mockResolvedValueOnce(makeCases(['TC-001', 'TC-002', 'TC-003', 'TC-004']))

    const promise = generateTestCasesResilient({
      provider: 'gemini',
      apiKey: 'k',
      model: 'm',
      spec,
      count: 8,
      signal: controller.signal,
      onPartialCases: () => controller.abort()
    })

    await expect(promise).rejects.toBeInstanceOf(GenerationAbortedError)
    expect(mockBatch).toHaveBeenCalledTimes(1) // never started the second batch
  })
})

describe('resumeFastGeneration', () => {
  it('continues from the checkpoint without re-generating completed batches', async () => {
    mockBatch.mockResolvedValueOnce(makeCases(['TC-005', 'TC-006']))

    const result = await resumeFastGeneration(
      { provider: 'openai', apiKey: 'k2', model: 'gpt-4o' },
      {
        spec,
        count: 6,
        testCases: makeCases(['TC-001', 'TC-002', 'TC-003', 'TC-004']),
        nextBatchIndex: 1,
        totalBatches: 2
      }
    )

    expect(mockBatch).toHaveBeenCalledTimes(1)
    expect(mockBatch.mock.calls[0][0]).toBe('openai') // uses the NEW provider/model
    expect(result).toHaveLength(6)
    expect(result.map(c => c.id)).toEqual(['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005', 'TC-006'])
  })
})
