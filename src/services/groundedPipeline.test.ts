import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./aiService', async importOriginal => {
  const actual = await importOriginal<typeof import('./aiService')>()
  return {
    ...actual,
    default: {
      complete: vi.fn(),
      makeRepairFn: vi.fn(() => async () => { throw new Error('repair unavailable in test') })
    }
  }
})

import aiService from './aiService'
import {
  runGroundedGeneration,
  extractRequirementsStage,
  analyzeRequirementTestability,
  generateFromRequirements,
  generateGapCases,
  generateInteractionCases,
  resumeGeneration,
  PipelineStallError,
  verifySnippet,
  finalizeCoverage,
  splitIntoSections
} from './groundedPipeline'
import type { Requirement, CoverageCell } from './schemas'
import type { TestCase } from './aiService'

const mockComplete = aiService.complete as ReturnType<typeof vi.fn>

const SPEC = 'Users must be able to log in with email and password. The system locks the account after 5 failed attempts.'

const requirementsResponse = JSON.stringify({
  requirements: [
    { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' },
    { id: 'REQ-002', text: 'Account lockout', sourceSnippet: 'locks the account after 5 failed attempts', category: 'functional', priority: 'high' }
  ]
})

const coverageResponse = JSON.stringify({
  coverage: [
    { requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' },
    { requirementId: 'REQ-002', scenarioType: 'negative', planned: 1, testCaseIds: [], status: 'gap' }
  ]
})

const fullSteps = Array.from({ length: 5 }, (_, i) => ({
  stepNumber: i + 1,
  action: `Do step ${i + 1}`,
  testData: `data-${i + 1}`,
  expectedResult: `Result ${i + 1}`
}))

const makeCase = (id: string, reqId: string, scenarioType = 'happy_path', steps = fullSteps) => ({
  id,
  summary: `Case ${id}`,
  issueType: 'Test',
  priority: 'High',
  labels: 'functional',
  testType: 'Functional',
  precondition: '',
  steps,
  status: 'Not Executed',
  component: 'Auth',
  estimatedTime: '10m',
  scenarioType,
  sourceRequirement: { requirementId: reqId, snippet: 'log in with email and password' }
})

const casesResponse = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001'), makeCase('TC-002', 'REQ-002', 'negative')] })

const critiqueAllPass = (ids: string[]) => JSON.stringify({
  verdicts: ids.map(id => ({ caseId: id, verdict: 'pass', note: '' }))
})

beforeEach(() => {
  mockComplete.mockReset()
})

describe('verifySnippet', () => {
  it('accepts verbatim quotes (case/whitespace-insensitive)', () => {
    expect(verifySnippet(SPEC, 'log in with  Email and password')).toBe(true)
  })

  it('accepts lightly paraphrased quotes via the in-order word fallback', () => {
    expect(verifySnippet(SPEC, 'locks the account after the 5 failed attempts')).toBe(true)
  })

  it('rejects fabricated snippets', () => {
    expect(verifySnippet(SPEC, 'supports biometric fingerprint authentication')).toBe(false)
    expect(verifySnippet(SPEC, '')).toBe(false)
  })
})

describe('splitIntoSections', () => {
  it('keeps small inputs as one section', () => {
    expect(splitIntoSections(SPEC)).toEqual([SPEC])
  })

  it('splits large inputs on paragraph boundaries', () => {
    const para = 'This is a requirement paragraph. '.repeat(200) // ~6.6k chars
    const input = [para, para, para, para].join('\n\n') // ~26k chars
    const sections = splitIntoSections(input)
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.every(s => s.length <= 16000)).toBe(true)
    // No content lost
    expect(sections.join('').replace(/\s+/g, '')).toBe(input.replace(/\s+/g, ''))
  })

  it('hard-splits a single oversized paragraph', () => {
    const oneBigParagraph = 'x'.repeat(40_000)
    const sections = splitIntoSections(oneBigParagraph)
    expect(sections.length).toBe(3)
  })
})

describe('analyzeRequirementTestability', () => {
  const reqs: Requirement[] = [
    { id: 'REQ-001', text: 'The app should be fast and user-friendly', sourceSnippet: 's', category: 'non_functional', priority: 'high' },
    { id: 'REQ-002', text: 'A user can log in with email and password', sourceSnippet: 's', category: 'functional', priority: 'high' }
  ]
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: '' }

  it('parses per-requirement verdicts, scores, issues and rewrites', async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      analyses: [
        { requirementId: 'REQ-001', verdict: 'untestable', score: 15, issues: ['ambiguous', 'unmeasurable'], rationale: 'no measurable outcome', suggestedRewrite: 'Home page loads within 2s on 4G' },
        { requirementId: 'REQ-002', verdict: 'testable', score: 92, issues: [], rationale: 'clear actor and outcome' }
      ]
    }))
    const { analyses, warnings } = await analyzeRequirementTestability(cfg, reqs)
    expect(warnings).toHaveLength(0)
    expect(analyses).toHaveLength(2)
    const a1 = analyses.find(a => a.requirementId === 'REQ-001')!
    expect(a1.verdict).toBe('untestable')
    expect(a1.issues).toContain('ambiguous')
    expect(a1.suggestedRewrite).toContain('2s')
    expect(analyses.find(a => a.requirementId === 'REQ-002')!.verdict).toBe('testable')
  })

  it('drops invented out-of-enum issue values instead of throwing', async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      analyses: [{ requirementId: 'REQ-001', verdict: 'weak', score: 40, issues: ['ambiguous', 'totally_made_up'], rationale: 'x' }]
    }))
    const { analyses } = await analyzeRequirementTestability(cfg, reqs)
    expect(analyses[0].issues).toEqual([])
  })

  it('is best-effort: a failed batch yields a warning, never throws', async () => {
    mockComplete.mockRejectedValueOnce(new Error('429 rate limit'))
    const { analyses, warnings } = await analyzeRequirementTestability(cfg, reqs)
    expect(analyses).toHaveLength(0)
    expect(warnings[0]).toMatch(/skipped/i)
  })

  it('returns empty without calling the model for an empty requirement list', async () => {
    const { analyses } = await analyzeRequirementTestability(cfg, [])
    expect(analyses).toHaveLength(0)
    expect(mockComplete).not.toHaveBeenCalled()
  })
})

describe('runGroundedGeneration', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: SPEC }

  it('runs 4 passes and returns grounded results', async () => {
    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await runGroundedGeneration(cfg)
    expect(mockComplete).toHaveBeenCalledTimes(4)
    expect(result.requirements).toHaveLength(2)
    expect(result.testCases).toHaveLength(2)
    expect(result.flagged).toHaveLength(0)
    expect(result.testCases.every(tc => tc.grounded === true)).toBe(true)
  })

  it('extracts section-by-section for large documents, deduping requirements', async () => {
    const filler = 'Additional descriptive filler text for the section body. '.repeat(170) // ~9.7k chars
    const para1 = `Users must be able to log in with email and password. ${filler}`
    const para2 = `The system locks the account after 5 failed attempts. ${filler}`
    const bigInput = `${para1}\n\n${para2}` // >16k chars → 2 sections

    const section1Reqs = JSON.stringify({
      requirements: [{ id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password' }]
    })
    // Section 2 re-extracts the login requirement (duplicate) plus its own
    const section2Reqs = JSON.stringify({
      requirements: [
        { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password' },
        { id: 'REQ-002', text: 'Account lockout', sourceSnippet: 'locks the account after 5 failed attempts' }
      ]
    })

    mockComplete
      .mockResolvedValueOnce(section1Reqs)
      .mockResolvedValueOnce(section2Reqs)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await runGroundedGeneration({ ...cfg, input: bigInput })
    // 2 extract + 1 plan + 1 generate + 1 critique
    expect(mockComplete).toHaveBeenCalledTimes(5)
    // Duplicate login requirement removed, ids renumbered sequentially
    expect(result.requirements).toHaveLength(2)
    expect(result.requirements.map(r => r.id)).toEqual(['REQ-001', 'REQ-002'])
  })

  it('marks requirements with fabricated snippets as ungrounded and warns', async () => {
    const fabricated = JSON.stringify({
      requirements: [
        { id: 'REQ-001', text: 'Login', sourceSnippet: 'log in with email and password' },
        { id: 'REQ-002', text: 'Invented', sourceSnippet: 'exports data to blockchain ledger' }
      ]
    })
    mockComplete
      .mockResolvedValueOnce(fabricated)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await runGroundedGeneration(cfg)
    expect(result.requirements.find(r => r.id === 'REQ-002')?.grounded).toBe(false)
    expect(result.warnings.some(w => w.includes('REQ-002'))).toBe(true)
  })

  it('fills planned coverage cells the model skipped (gap-fill pass)', async () => {
    // Generation only returns the REQ-001 case; REQ-002/negative is missing
    const partialCases = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] })
    const gapFillCases = JSON.stringify({ testCases: [makeCase('TC-002', 'REQ-002', 'negative')] })

    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(partialCases)
      .mockResolvedValueOnce(gapFillCases)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await runGroundedGeneration(cfg)
    // extract + plan + generate + gap-fill + critique
    expect(mockComplete).toHaveBeenCalledTimes(5)
    expect(result.testCases).toHaveLength(2)
    const negCell = result.coverage.find(c => c.requirementId === 'REQ-002' && c.scenarioType === 'negative')
    expect(negCell?.status).toBe('covered')
  })

  it('expands shallow cases (< 4 steps) with a step-expansion pass', async () => {
    const thinSteps = fullSteps.slice(0, 2)
    const thinCase = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001', 'happy_path', thinSteps), makeCase('TC-002', 'REQ-002', 'negative')] })
    const expandedCase = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001', 'happy_path', fullSteps.slice(0, 6).concat({ stepNumber: 6, action: 'Verify', testData: '', expectedResult: 'Done' }))] })

    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(thinCase)
      .mockResolvedValueOnce(expandedCase)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await runGroundedGeneration(cfg)
    // extract + plan + generate + expand + critique
    expect(mockComplete).toHaveBeenCalledTimes(5)
    const expanded = result.testCases.find(tc => tc.id === 'TC-001')
    expect(expanded!.steps.length).toBeGreaterThanOrEqual(4)
  })

  it('moves critique-ungrounded cases to flagged instead of dropping them', async () => {
    const critiqueFlagging = JSON.stringify({
      verdicts: [
        { caseId: 'TC-001', verdict: 'pass', note: '' },
        { caseId: 'TC-002', verdict: 'ungrounded', note: 'Tests lockout duration which the spec never states' }
      ]
    })
    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueFlagging)

    const result = await runGroundedGeneration(cfg)
    expect(result.testCases.map(tc => tc.id)).toEqual(['TC-001'])
    expect(result.flagged).toHaveLength(1)
    expect(result.flagged[0].id).toBe('TC-002')
    expect(result.flagged[0].grounded).toBe(false)
    expect(result.flagged[0].critiqueNote).toMatch(/lockout duration/)
  })

  it('degrades gracefully when the critique pass fails', async () => {
    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockRejectedValueOnce(new Error('provider exploded'))

    const result = await runGroundedGeneration(cfg)
    expect(result.testCases).toHaveLength(2)
    expect(result.flagged).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('Self-critique pass failed'))).toBe(true)
  })

  it('chunks generation by planned-case budget for large requirement sets', async () => {
    const manyReqs = Array.from({ length: 16 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, '0')}`,
      text: `Requirement ${i + 1}`,
      sourceSnippet: 'log in with email and password'
    }))
    const manyCoverage = manyReqs.map(r => ({
      requirementId: r.id, scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap'
    }))
    const allSixteenCases = (start: number, reqOffset: number) => JSON.stringify({
      testCases: Array.from({ length: 8 }, (_, i) =>
        makeCase(`TC-${String(start + i).padStart(3, '0')}`, `REQ-${String(reqOffset + i).padStart(3, '0')}`))
    })

    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ requirements: manyReqs }))
      .mockResolvedValueOnce(JSON.stringify({ coverage: manyCoverage }))
      // 16 reqs → 2 generate batches of 8 (cap: 8 reqs / 15 planned cases per call)
      .mockResolvedValueOnce(allSixteenCases(1, 1))
      .mockResolvedValueOnce(allSixteenCases(9, 9))
      .mockResolvedValueOnce(critiqueAllPass(Array.from({ length: 16 }, (_, i) => `TC-${String(i + 1).padStart(3, '0')}`)))

    const result = await runGroundedGeneration(cfg)
    // 1 extract + 1 plan + 2 generate + 1 critique (no gaps → no gap-fill)
    expect(mockComplete).toHaveBeenCalledTimes(5)
    expect(result.testCases.length).toBe(16)
  })
})

describe('per-pass model routing', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'main-model', input: SPEC, utilityModel: 'cheap-model' }

  it('routes extract+plan to the utility model, generate+critique to the main model', async () => {
    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    await runGroundedGeneration(cfg)
    // aiService.complete(provider, apiKey, model, ...)
    const modelsUsed = mockComplete.mock.calls.map(c => c[2])
    expect(modelsUsed).toEqual(['cheap-model', 'cheap-model', 'main-model', 'main-model'])
  })

  it('uses the main model everywhere when no utility model is set', async () => {
    mockComplete
      .mockResolvedValueOnce(requirementsResponse)
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    await runGroundedGeneration({ ...cfg, utilityModel: undefined })
    const modelsUsed = mockComplete.mock.calls.map(c => c[2])
    expect(modelsUsed).toEqual(['main-model', 'main-model', 'main-model', 'main-model'])
  })
})

describe('two-stage flow (requirement review checkpoint)', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: SPEC }

  it('extractRequirementsStage returns requirements + warnings without generating', async () => {
    mockComplete.mockResolvedValueOnce(requirementsResponse)
    const result = await extractRequirementsStage(cfg)
    expect(mockComplete).toHaveBeenCalledTimes(1)
    expect(result.requirements).toHaveLength(2)
    expect(result.warnings).toEqual([])
  })

  it('generateFromRequirements runs plan→generate→critique over an edited list', async () => {
    // User deleted REQ-002 during review and kept only REQ-001
    const reviewed: Requirement[] = [
      { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high', grounded: true }
    ]
    const singleCoverage = JSON.stringify({
      coverage: [{ requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' }]
    })
    const singleCase = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] })

    mockComplete
      .mockResolvedValueOnce(singleCoverage)
      .mockResolvedValueOnce(singleCase)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001']))

    const result = await generateFromRequirements(cfg, reviewed, ['carried warning'])
    // plan + generate + critique – NO extract call
    expect(mockComplete).toHaveBeenCalledTimes(3)
    expect(result.requirements).toEqual(reviewed)
    expect(result.testCases).toHaveLength(1)
    expect(result.warnings).toContain('carried warning')
  })

  it('streams partial cases via onPartialCases as batches land', async () => {
    const reviewed: Requirement[] = [
      { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high', grounded: true }
    ]
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ coverage: [{ requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' }] }))
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] }))
      .mockResolvedValueOnce(critiqueAllPass(['TC-001']))

    const partials: number[] = []
    await generateFromRequirements(
      { ...cfg, onPartialCases: cases => partials.push(cases.length) },
      reviewed,
      []
    )
    // The generate batch must have emitted at least one partial snapshot.
    expect(partials.length).toBeGreaterThanOrEqual(1)
    expect(partials[partials.length - 1]).toBe(1)
  })

  it('threads automationFriendly into the plan + generate prompts', async () => {
    const reviewed: Requirement[] = [
      { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' }
    ]
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ coverage: [{ requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' }] }))
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] }))
      .mockResolvedValueOnce(critiqueAllPass(['TC-001']))

    await generateFromRequirements(cfg, reviewed, [], { automationFriendly: true })
    const generatePrompt = mockComplete.mock.calls[1][3] as string
    expect(generatePrompt).toContain('AUTOMATION-FRIENDLY MODE')
    expect(generatePrompt).toContain('SELF-CONTAINED')
  })

  it('threads focusInstructions into the plan + generate prompts', async () => {
    const reviewed: Requirement[] = [
      { id: 'REQ-001', text: 'Login with email/password', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' }
    ]
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ coverage: [{ requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' }] }))
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] }))
      .mockResolvedValueOnce(critiqueAllPass(['TC-001']))

    await generateFromRequirements(cfg, reviewed, [], { focusInstructions: 'Only the password reset flow' })
    const planPrompt = mockComplete.mock.calls[0][3] as string
    const generatePrompt = mockComplete.mock.calls[1][3] as string
    expect(planPrompt).toContain('Only the password reset flow')
    expect(generatePrompt).toContain('Only the password reset flow')
  })
})

describe('pipeline resumability (PipelineStallError / resumeGeneration)', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: SPEC }
  const twoReqs: Requirement[] = [
    { id: 'REQ-001', text: 'Login', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' },
    { id: 'REQ-002', text: 'Lockout', sourceSnippet: 'locks the account after 5 failed attempts', category: 'functional', priority: 'high' }
  ]

  it('throws PipelineStallError with a plan checkpoint when the plan call fails', async () => {
    mockComplete.mockRejectedValueOnce(new Error('rate limited'))

    let caught: any
    try {
      await generateFromRequirements(cfg, twoReqs)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PipelineStallError)
    expect(caught.checkpoint.stage).toBe('plan')
    expect(caught.checkpoint.nextIndex).toBe(0)
    expect(caught.checkpoint.coverage).toEqual([])
    expect(caught.checkpoint.requirements).toEqual(twoReqs)
  })

  it('resumes a stalled plan from the checkpoint with a different model, completing normally', async () => {
    mockComplete.mockRejectedValueOnce(new Error('rate limited'))
    let checkpoint: any
    try {
      await generateFromRequirements(cfg, twoReqs)
    } catch (err: any) {
      checkpoint = err.checkpoint
    }
    expect(checkpoint).toBeDefined()
    mockComplete.mockClear() // isolate the resume call's own provider usage

    mockComplete
      .mockResolvedValueOnce(coverageResponse)
      .mockResolvedValueOnce(casesResponse)
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const switchedCfg = { ...cfg, provider: 'groq' as const, model: 'llama-3.3-70b-versatile' }
    const result = await resumeGeneration(switchedCfg, checkpoint)
    expect(result.testCases).toHaveLength(2)
    // Resumed calls went to the NEW provider/model
    expect(mockComplete.mock.calls.every(c => c[0] === 'groq')).toBe(true)
  })

  it('throws PipelineStallError with a generate checkpoint (preserving already-generated cases) when a later batch fails', async () => {
    const manyReqs = Array.from({ length: 16 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, '0')}`, text: `Req ${i + 1}`, sourceSnippet: 'log in with email and password',
      category: 'functional' as const, priority: 'high' as const
    }))
    const manyCoverage = manyReqs.map(r => ({ requirementId: r.id, scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' }))

    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ coverage: manyCoverage })) // plan (single chunk, 16 <= 20)
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] })) // generate batch 1/2 succeeds
      .mockRejectedValueOnce(new Error('rate limited')) // generate batch 2/2 fails

    let caught: any
    try {
      await generateFromRequirements(cfg, manyReqs)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PipelineStallError)
    expect(caught.checkpoint.stage).toBe('generate')
    expect(caught.checkpoint.nextIndex).toBe(1) // batch index 1 (second batch) failed
    expect(caught.checkpoint.testCases).toHaveLength(1) // batch 1's case preserved
    expect(caught.checkpoint.coverage).toHaveLength(16) // plan already completed, not lost
  })

  it('resume from a generate checkpoint only re-calls the remaining batches, not the completed ones', async () => {
    const manyReqs = Array.from({ length: 16 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, '0')}`, text: `Req ${i + 1}`, sourceSnippet: 'log in with email and password',
      category: 'functional' as const, priority: 'high' as const
    }))
    // Only REQ-001 and REQ-009 are actually planned (matching what the mocked
    // batches below return) so the gap-fill pass has nothing to do and the
    // call count after resume stays exactly predictable.
    const manyCoverage = manyReqs.map(r => ({
      requirementId: r.id,
      scenarioType: 'happy_path',
      planned: r.id === 'REQ-001' || r.id === 'REQ-009' ? 1 : 0,
      testCaseIds: [],
      status: r.id === 'REQ-001' || r.id === 'REQ-009' ? 'gap' : 'not_applicable'
    }))

    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ coverage: manyCoverage }))
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-001')] }))
      .mockRejectedValueOnce(new Error('rate limited'))

    let checkpoint: any
    try {
      await generateFromRequirements(cfg, manyReqs)
    } catch (err: any) {
      checkpoint = err.checkpoint
    }
    mockComplete.mockClear()

    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ testCases: [makeCase('TC-002', 'REQ-009')] })) // remaining batch
      .mockResolvedValueOnce(critiqueAllPass(['TC-001', 'TC-002']))

    const result = await resumeGeneration(cfg, checkpoint)
    // Only 2 calls: the remaining generate batch + critique – no re-plan, no re-batch-1, no gap-fill
    expect(mockComplete).toHaveBeenCalledTimes(2)
    expect(result.testCases.map(tc => tc.id)).toEqual(expect.arrayContaining(['TC-001', 'TC-002']))
    expect(result.testCases).toHaveLength(2)
  })
})

describe('generateGapCases (gap-driven Add More)', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: SPEC }
  const reqs: Requirement[] = [
    { id: 'REQ-001', text: 'Login', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' },
    { id: 'REQ-002', text: 'Lockout', sourceSnippet: 'locks the account after 5 failed attempts', category: 'functional', priority: 'high' }
  ]
  const fullCoverage: CoverageCell[] = [
    { requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 1, testCaseIds: [], status: 'gap' },
    { requirementId: 'REQ-002', scenarioType: 'negative', planned: 1, testCaseIds: [], status: 'gap' }
  ]

  it('returns noGaps when every planned cell is already filled', async () => {
    const existing = [makeCase('TC-001', 'REQ-001'), makeCase('TC-002', 'REQ-002', 'negative')] as unknown as TestCase[]
    const result = await generateGapCases(cfg, reqs, fullCoverage, existing)
    expect(result.noGaps).toBe(true)
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('generates audited cases only for under-filled cells, numbered after existing', async () => {
    // Only REQ-001/happy_path is covered; REQ-002/negative is a gap
    const existing = [makeCase('TC-007', 'REQ-001')] as unknown as TestCase[]
    const gapCase = JSON.stringify({ testCases: [makeCase('TC-001', 'REQ-002', 'negative')] })

    mockComplete
      .mockResolvedValueOnce(gapCase)
      .mockResolvedValueOnce(critiqueAllPass(['TC-008']))

    const result = await generateGapCases(cfg, reqs, fullCoverage, existing)
    // 1 generate + 1 critique, no extract/plan
    expect(mockComplete).toHaveBeenCalledTimes(2)
    expect(result.noGaps).toBe(false)
    expect(result.testCases).toHaveLength(1)
    // Continues numbering after the existing suite (TC-007 → TC-008)
    expect(result.testCases[0].id).toBe('TC-008')
    expect(result.testCases[0].sourceRequirement?.requirementId).toBe('REQ-002')
  })

  it('routes critique-flagged gap cases to flagged, not the main suite', async () => {
    const existing = [makeCase('TC-001', 'REQ-001')] as unknown as TestCase[]
    const gapCase = JSON.stringify({ testCases: [makeCase('TC-002', 'REQ-002', 'negative')] })
    const critiqueFlag = JSON.stringify({
      verdicts: [{ caseId: 'TC-002', verdict: 'ungrounded', note: 'overreach' }]
    })

    mockComplete
      .mockResolvedValueOnce(gapCase)
      .mockResolvedValueOnce(critiqueFlag)

    const result = await generateGapCases(cfg, reqs, fullCoverage, existing)
    expect(result.testCases).toHaveLength(0)
    expect(result.flagged).toHaveLength(1)
    expect(result.flagged[0].critiqueNote).toBe('overreach')
  })
})

describe('generateInteractionCases', () => {
  const cfg = { provider: 'gemini' as const, apiKey: 'k', model: 'm', input: SPEC }
  const reqs: Requirement[] = [
    { id: 'REQ-001', text: 'Login', sourceSnippet: 'log in with email and password', category: 'functional', priority: 'high' },
    { id: 'REQ-002', text: 'Lockout', sourceSnippet: 'locks the account after 5 failed attempts', category: 'functional', priority: 'high' }
  ]
  const existing = [makeCase('TC-001', 'REQ-001'), makeCase('TC-002', 'REQ-002', 'negative')] as unknown as TestCase[]

  it('returns interaction cases citing multiple requirements, audited and renumbered', async () => {
    const interactionCase = {
      ...makeCase('TC-001', 'REQ-001', 'edge_case'),
      relatedRequirementIds: ['REQ-002']
    }
    mockComplete
      .mockResolvedValueOnce(JSON.stringify({ testCases: [interactionCase] }))
      .mockResolvedValueOnce(critiqueAllPass(['TC-003']))

    const result = await generateInteractionCases(cfg, reqs, existing)
    expect(mockComplete).toHaveBeenCalledTimes(2) // generate + critique
    expect(result.noInteractions).toBe(false)
    expect(result.testCases).toHaveLength(1)
    expect(result.testCases[0].id).toBe('TC-003') // continues after existing
    expect(result.testCases[0].relatedRequirementIds).toEqual(['REQ-002'])
  })

  it('drops generated cases that only cite one requirement', async () => {
    const singleReqCase = makeCase('TC-001', 'REQ-001', 'edge_case') // no relatedRequirementIds
    mockComplete.mockResolvedValueOnce(JSON.stringify({ testCases: [singleReqCase] }))

    const result = await generateInteractionCases(cfg, reqs, existing)
    expect(result.noInteractions).toBe(true)
    expect(result.testCases).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('only cited one requirement'))).toBe(true)
  })

  it('accepts an honest empty answer without a repair round-trip', async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({ testCases: [] }))
    const result = await generateInteractionCases(cfg, reqs, existing)
    expect(result.noInteractions).toBe(true)
    expect(mockComplete).toHaveBeenCalledTimes(1) // no critique needed
  })

  it('short-circuits with fewer than two requirements', async () => {
    const result = await generateInteractionCases(cfg, [reqs[0]], existing)
    expect(result.noInteractions).toBe(true)
    expect(mockComplete).not.toHaveBeenCalled()
  })
})

describe('finalizeCoverage', () => {
  const reqs: Requirement[] = [
    { id: 'REQ-001', text: 'Login', sourceSnippet: 's', category: 'functional', priority: 'high' }
  ]
  const planned: CoverageCell[] = [
    { requirementId: 'REQ-001', scenarioType: 'happy_path', planned: 2, testCaseIds: [], status: 'gap' },
    { requirementId: 'REQ-001', scenarioType: 'negative', planned: 1, testCaseIds: [], status: 'gap' },
    { requirementId: 'REQ-001', scenarioType: 'performance', planned: 0, testCaseIds: [], status: 'not_applicable' }
  ]

  it('computes covered / partial / gap / not_applicable from actual cases', () => {
    const cases = [makeCase('TC-001', 'REQ-001', 'happy_path')] as unknown as TestCase[]
    const cells = finalizeCoverage(planned, reqs, cases)

    const get = (st: string) => cells.find(c => c.scenarioType === st)!
    expect(get('happy_path').status).toBe('partial') // 1 of 2 planned
    expect(get('happy_path').testCaseIds).toEqual(['TC-001'])
    expect(get('negative').status).toBe('gap')
    expect(get('performance').status).toBe('not_applicable')
    expect(get('security').status).toBe('not_applicable') // unplanned combo
    expect(cells).toHaveLength(7) // full scenario axis for the requirement
  })
})
