import { describe, it, expect } from 'vitest'
import { TestCaseSchema, TestCasesPayloadSchema, RequirementListSchema } from './schemas'

const validCase = {
  id: 'TC-001',
  summary: 'Verify login with valid credentials',
  issueType: 'Test',
  priority: 'High',
  labels: 'functional,happy_path',
  testType: 'Functional',
  precondition: 'User account exists',
  steps: [{ stepNumber: 1, action: 'Enter email', testData: 'user@example.com', expectedResult: 'Field accepts input' }],
  status: 'Not Executed',
  component: 'Auth',
  estimatedTime: '15m',
  scenarioType: 'happy_path'
}

describe('TestCaseSchema', () => {
  it('accepts a fully-populated case', () => {
    expect(TestCaseSchema.safeParse(validCase).success).toBe(true)
  })

  it('accepts a case WITHOUT sourceRequirement (rules engine / CSV import compat)', () => {
    const result = TestCaseSchema.safeParse(validCase)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.sourceRequirement).toBeUndefined()
  })

  it('accepts a case WITH sourceRequirement + critique fields', () => {
    const result = TestCaseSchema.safeParse({
      ...validCase,
      sourceRequirement: { requirementId: 'REQ-001', snippet: 'Users must log in with email' },
      grounded: true,
      critiqueNote: ''
    })
    expect(result.success).toBe(true)
  })

  it('coerces string stepNumber to number (LLM looseness)', () => {
    const result = TestCaseSchema.safeParse({
      ...validCase,
      steps: [{ stepNumber: '1', action: 'x', testData: 'y', expectedResult: 'z' }]
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.steps[0].stepNumber).toBe(1)
  })

  it('fills defaults for optional metadata fields', () => {
    const minimal = {
      id: 'TC-002',
      summary: 'Minimal case',
      steps: validCase.steps,
      scenarioType: 'negative'
    }
    const result = TestCaseSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issueType).toBe('Test')
      expect(result.data.status).toBe('Not Executed')
    }
  })

  it('rejects an invalid scenarioType', () => {
    expect(TestCaseSchema.safeParse({ ...validCase, scenarioType: 'chaos_monkey' }).success).toBe(false)
  })

  it('rejects a case with zero steps', () => {
    expect(TestCaseSchema.safeParse({ ...validCase, steps: [] }).success).toBe(false)
  })
})

describe('TestCasesPayloadSchema (shape normalization)', () => {
  it('accepts a bare array', () => {
    const result = TestCasesPayloadSchema.safeParse([validCase])
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(1)
  })

  it('unwraps a {testCases: [...]} object (JSON-mode wrapper)', () => {
    const result = TestCasesPayloadSchema.safeParse({ testCases: [validCase, validCase] })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(2)
  })

  it('wraps a lone case object into an array', () => {
    const result = TestCasesPayloadSchema.safeParse(validCase)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(1)
  })

  it('rejects an empty array', () => {
    expect(TestCasesPayloadSchema.safeParse([]).success).toBe(false)
  })
})

describe('RequirementListSchema', () => {
  it('accepts requirements and defaults category/priority', () => {
    const result = RequirementListSchema.safeParse({
      requirements: [{ id: 'REQ-001', text: 'Login works', sourceSnippet: 'user can log in' }]
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requirements[0].category).toBe('functional')
      expect(result.data.requirements[0].priority).toBe('medium')
    }
  })

  it('rejects an empty requirement list', () => {
    expect(RequirementListSchema.safeParse({ requirements: [] }).success).toBe(false)
  })
})
