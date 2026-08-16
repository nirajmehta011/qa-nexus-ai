import { z } from 'zod'

// ── Traceability types ────────────────────────────────────────────────────────

export interface SourceCitation {
  requirementId: string
  snippet: string // verbatim quote from the source input
}

export interface Requirement {
  id: string // "REQ-001"
  text: string
  sourceSnippet: string // verbatim quote (≤200 chars) from the input
  category: 'functional' | 'non_functional' | 'ui' | 'data' | 'integration'
  priority: 'high' | 'medium' | 'low'
  grounded?: boolean // false when sourceSnippet could not be verified against the input
}

// ── Requirement testability analysis ─────────────────────────────────────────
// Advisory quality check run on extracted requirements BEFORE generation, so a
// vague/untestable requirement is caught at the review step (30s to fix) rather
// than after 5 test cases are built on top of it.

export type TestabilityVerdict = 'testable' | 'weak' | 'untestable'

export type TestabilityIssue =
  | 'ambiguous' // vague, subjective wording ("fast", "user-friendly")
  | 'unmeasurable' // no observable/measurable outcome to assert against
  | 'no_acceptance_criteria' // no clear definition of done
  | 'compound' // multiple distinct requirements fused into one
  | 'contradiction' // conflicts with another requirement in the set
  | 'implementation_detail' // describes HOW, not the WHAT to verify
  | 'missing_actor' // no clear who/role performs the behaviour

export const TESTABILITY_ISSUES: TestabilityIssue[] = [
  'ambiguous',
  'unmeasurable',
  'no_acceptance_criteria',
  'compound',
  'contradiction',
  'implementation_detail',
  'missing_actor'
]

export interface RequirementAnalysis {
  requirementId: string
  verdict: TestabilityVerdict
  score: number // 0–100 testability confidence
  issues: TestabilityIssue[]
  rationale: string // one-line explanation
  suggestedRewrite?: string // a testable phrasing the user can accept in one click
}

export type CoverageStatus = 'covered' | 'partial' | 'gap' | 'not_applicable'

export interface CoverageCell {
  requirementId: string
  scenarioType: ScenarioType
  planned: number
  testCaseIds: string[]
  status: CoverageStatus
}

export type ScenarioType =
  | 'happy_path'
  | 'negative'
  | 'edge_case'
  | 'boundary'
  | 'ui_ux'
  | 'security'
  | 'performance'

export const SCENARIO_TYPES: ScenarioType[] = [
  'happy_path',
  'negative',
  'edge_case',
  'boundary',
  'ui_ux',
  'security',
  'performance'
]

// ── Zod schemas (tolerant of LLM looseness: passthrough + coercion) ──────────

const scenarioTypeSchema = z.enum([
  'happy_path',
  'negative',
  'edge_case',
  'boundary',
  'ui_ux',
  'security',
  'performance'
])

export const TestStepSchema = z
  .object({
    stepNumber: z.coerce.number(),
    action: z.string(),
    testData: z.coerce.string().default(''),
    expectedResult: z.string()
  })
  .passthrough()

export const SourceCitationSchema = z
  .object({
    requirementId: z.string(),
    snippet: z.string()
  })
  .passthrough()

export const TestCaseSchema = z
  .object({
    id: z.string(),
    summary: z.string(),
    issueType: z.string().default('Test'),
    priority: z.string().default('Medium'),
    labels: z.coerce.string().default(''),
    testType: z.string().default('Functional'),
    precondition: z.coerce.string().default(''),
    steps: z.array(TestStepSchema).min(1),
    status: z.string().default('Not Executed'),
    component: z.string().default(''),
    estimatedTime: z.string().default('15m'),
    scenarioType: scenarioTypeSchema,
    // Optional traceability fields – absent for rules-engine output, CSV
    // imports, generateMore/custom/extract flows.
    sourceRequirement: SourceCitationSchema.optional(),
    // Interaction cases span multiple requirements: primary in
    // sourceRequirement, the rest here.
    relatedRequirementIds: z.array(z.string()).optional(),
    grounded: z.boolean().optional(),
    critiqueNote: z.string().optional()
  })
  .passthrough()

export const TestCaseArraySchema = z.array(TestCaseSchema).min(1)

// JSON mode makes some providers wrap the array in an object (or return a
// single case) – accept all three shapes and normalize to an array.
export const TestCasesPayloadSchema = z.preprocess(v => {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    if (Array.isArray(obj.testCases)) return obj.testCases
    if (obj.summary || obj.id) return [obj]
  }
  return v
}, TestCaseArraySchema)

export const RequirementSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    sourceSnippet: z.string(),
    category: z.enum(['functional', 'non_functional', 'ui', 'data', 'integration']).default('functional'),
    priority: z.enum(['high', 'medium', 'low']).default('medium')
  })
  .passthrough()

export const RequirementListSchema = z
  .object({ requirements: z.array(RequirementSchema).min(1) })
  .passthrough()

export const RequirementAnalysisSchema = z
  .object({
    requirementId: z.string(),
    verdict: z.enum(['testable', 'weak', 'untestable']).default('weak'),
    score: z.coerce.number().min(0).max(100).catch(50).default(50),
    issues: z
      .array(
        z.enum([
          'ambiguous',
          'unmeasurable',
          'no_acceptance_criteria',
          'compound',
          'contradiction',
          'implementation_detail',
          'missing_actor'
        ])
      )
      // If the model invents an out-of-enum issue value, fall back to an empty
      // issues list for that requirement rather than failing the whole parse.
      .catch([])
      .default([]),
    rationale: z.string().default(''),
    suggestedRewrite: z.string().optional()
  })
  .passthrough()

export const TestabilityReportSchema = z
  .object({ analyses: z.array(RequirementAnalysisSchema) })
  .passthrough()

// ── Coverage-gap analysis vs an imported existing suite ───────────────────────
// The LLM maps each imported case to the requirement IDs it actually covers.
export const SuiteMappingSchema = z
  .object({
    mappings: z.array(
      z
        .object({
          caseRef: z.string(),
          requirementIds: z.array(z.string()).catch([]).default([])
        })
        .passthrough()
    )
  })
  .passthrough()

export const CoverageCellSchema = z
  .object({
    requirementId: z.string(),
    scenarioType: scenarioTypeSchema,
    planned: z.coerce.number().default(0),
    testCaseIds: z.array(z.string()).default([]),
    status: z.enum(['covered', 'partial', 'gap', 'not_applicable']).default('gap')
  })
  .passthrough()

export const CoveragePlanSchema = z
  .object({ coverage: z.array(CoverageCellSchema).min(1) })
  .passthrough()

export const CritiqueVerdictSchema = z
  .object({
    caseId: z.string(),
    verdict: z.enum(['pass', 'ungrounded', 'fix']),
    note: z.string().optional().default('')
  })
  .passthrough()

export const CritiqueResultSchema = z
  .object({ verdicts: z.array(CritiqueVerdictSchema) })
  .passthrough()

export type RequirementList = z.infer<typeof RequirementListSchema>
export type CoveragePlan = z.infer<typeof CoveragePlanSchema>
export type CritiqueResult = z.infer<typeof CritiqueResultSchema>
export type TestabilityReport = z.infer<typeof TestabilityReportSchema>
export type SuiteMapping = z.infer<typeof SuiteMappingSchema>

// ─── Grounding confidence (second-pass LLM judge) ────────────────────────────

export const ConfidenceSchema = z
  .object({
    testCaseId: z.string(),
    score: z.coerce.number().min(0).max(100),
    verdict: z.enum(['high', 'medium', 'low']),
    reason: z.string().default('')
  })
  .passthrough()

export const ConfidenceReportSchema = z.preprocess(v => {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    if (Array.isArray(obj.assessments)) return obj.assessments
    if (Array.isArray(obj.testCases)) return obj.testCases
  }
  return v
}, z.array(ConfidenceSchema))

export type ConfidenceAssessment = z.infer<typeof ConfidenceSchema>
