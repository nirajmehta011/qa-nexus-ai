import aiService, { GenerationAbortedError, type GenOptions, type MediaFileData, type TestCase } from './aiService'
import type { AIProvider } from '../context/SettingsContext'
import { parseWithRepair, extractJson } from './jsonParser'
import {
  RequirementListSchema,
  CoveragePlanSchema,
  CritiqueResultSchema,
  TestCasesPayloadSchema,
  TestabilityReportSchema,
  SCENARIO_TYPES,
  type CoverageCell,
  type Requirement,
  type RequirementAnalysis,
  type ScenarioType
} from './schemas'

export interface PipelineProgress {
  pass: 'extract' | 'analyze' | 'plan' | 'generate' | 'critique'
  status: 'running' | 'done' | 'error'
  detail?: string
}

export interface GroundedResult {
  requirements: Requirement[]
  coverage: CoverageCell[]
  testCases: TestCase[]
  flagged: TestCase[]
  warnings: string[]
}

export interface GroundedConfig {
  provider: AIProvider
  apiKey: string
  model: string
  /** Normalized source text (summary + description) the requirements must be grounded in. */
  input: string
  mediaFiles?: MediaFileData[]
  /** Visual-only inputs have no source text to verify snippets against. */
  isVisual?: boolean
  context?: { strategy?: string; plan?: string }
  onProgress?: (p: PipelineProgress) => void
  /**
   * Streaming hook: called with the running (un-audited, pre-renumber) test
   * case list after each generate/gap-fill/expand batch so the UI can show
   * cases as they land instead of a blank spinner. Preliminary – the final
   * returned suite is renumbered and critique-audited.
   */
  onPartialCases?: (cases: TestCase[]) => void
  /** Output token budget per pass (default 8000; lower for tight provider TPM limits). */
  maxTokens?: number
  /**
   * Optional cheaper/faster model for the mechanical passes (extract, plan).
   * The judgment passes (generate, critique) always use `model`.
   */
  utilityModel?: string
  /** Lets the caller cancel mid-run — wired to the Stop button. Checked at
   *  every chunk boundary and passed to every underlying request. */
  signal?: AbortSignal
  /** Optional user-provided scope, applied at extraction so only matching requirements are pulled from the spec. */
  scopeInstructions?: string
}

/** Merges the run's cancellation signal into a call's own options. */
function withSignal(opts: GenOptions, cfg: GroundedConfig): GenOptions {
  return cfg.signal ? { ...opts, signal: cfg.signal } : opts
}

/** Throws if the caller has stopped the run. Call at the top of every loop iteration. */
function checkAborted(cfg: GroundedConfig): void {
  if (cfg.signal?.aborted) throw new GenerationAbortedError()
}

// Large specs are extracted section-by-section (map-reduce) so the output
// token cap never silently truncates the requirement list.
const EXTRACT_SECTION_CHAR_LIMIT = 16_000
const MAX_SECTIONS = 40
// Coverage planning chunks for big requirement sets (output budget again).
const PLAN_CHUNK_SIZE = 20
// Generation groups requirements so no single call is asked for more cases
// than its output budget can express in full detail.
const MAX_REQS_PER_GENERATE_CALL = 8
const MAX_PLANNED_CASES_PER_CALL = 15
// Cases below this step count get rewritten by the expansion pass.
const MIN_STEPS_PER_CASE = 4
const EXPAND_BATCH_SIZE = 10

// ── Snippet grounding check ───────────────────────────────────────────────────

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

// Verbatim containment first; falls back to ≥85% of the snippet's words
// appearing in order (LLMs lightly paraphrase quotes – don't over-flag).
export function verifySnippet(input: string, snippet: string): boolean {
  const normInput = normalize(input)
  const normSnippet = normalize(snippet)
  if (!normSnippet) return false
  if (normInput.includes(normSnippet)) return true

  const words = normSnippet.split(' ').filter(w => w.length > 2)
  if (words.length === 0) return false
  let searchFrom = 0
  let found = 0
  for (const word of words) {
    const at = normInput.indexOf(word, searchFrom)
    if (at !== -1) {
      found++
      searchFrom = at + word.length
    }
  }
  return found / words.length >= 0.85
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildExtractPrompt(
  input: string,
  isVisual: boolean,
  sectionInfo?: { index: number; total: number },
  scopeInstructions?: string
): string {
  const sectionNote = sectionInfo && sectionInfo.total > 1
    ? `\nNote: this is section ${sectionInfo.index} of ${sectionInfo.total} of a larger specification – extract every testable requirement found in THIS section.`
    : ''
  const scopeNote = scopeInstructions?.trim()
    ? `\n\nSCOPE — READ CAREFULLY: the user wants extraction limited to the following. Only extract requirements that relate to this scope, even if the specification covers other things too:\n${scopeInstructions.trim()}`
    : ''
  return `You are a senior QA analyst. Extract EVERY testable requirement from the specification below. Be exhaustive – a missed requirement means missed test coverage.

Rules:
- Do NOT invent requirements. Only list what the specification states or directly implies.
- For each requirement, "sourceSnippet" must be a VERBATIM quote (max 200 characters) copied exactly from the specification text${isVisual ? ' (or an exact description of the visual element it comes from)' : ''}.
- "text" is a single testable sentence in your own words.
- Use sequential ids: REQ-001, REQ-002, ...
- "category" is one of: functional, non_functional, ui, data, integration.
- "priority" is one of: high, medium, low.${sectionNote}${scopeNote}

Return ONLY valid JSON in this exact shape:
{"requirements": [{"id": "REQ-001", "text": "...", "sourceSnippet": "...", "category": "functional", "priority": "high"}]}

Specification:
"""
${input}
"""`
}

// Split a large document into paragraph-aligned sections that each fit
// comfortably in one extraction call.
export function splitIntoSections(input: string): string[] {
  if (input.length <= EXTRACT_SECTION_CHAR_LIMIT) return [input]

  const paragraphs = input.split(/\n\s*\n/)
  const sections: string[] = []
  let current = ''
  for (const para of paragraphs) {
    // A single paragraph larger than the limit gets hard-split
    if (para.length > EXTRACT_SECTION_CHAR_LIMIT) {
      if (current) { sections.push(current); current = '' }
      for (let i = 0; i < para.length; i += EXTRACT_SECTION_CHAR_LIMIT) {
        sections.push(para.slice(i, i + EXTRACT_SECTION_CHAR_LIMIT))
      }
      continue
    }
    if (current.length + para.length + 2 > EXTRACT_SECTION_CHAR_LIMIT) {
      sections.push(current)
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current) sections.push(current)
  return sections
}

function buildCoveragePlanPrompt(requirements: Requirement[], focusInstructions?: string): string {
  return `You are a senior QA architect planning test coverage.

For each requirement below, decide which scenario types apply and how many test cases each combination needs. Scenario types: ${SCENARIO_TYPES.join(', ')}.

Rules:
- Mark combinations that make no sense for the requirement as "not_applicable" with planned 0.
- Applicable combinations get "gap" status (nothing is generated yet) and planned 1-3.
- Every requirement must appear with at least one applicable scenario type.
${focusInstructions ? `\nUSER FOCUS INSTRUCTIONS (bias coverage toward this, without ignoring other requirements entirely): ${focusInstructions}\n` : ''}
Return ONLY valid JSON in this exact shape:
{"coverage": [{"requirementId": "REQ-001", "scenarioType": "happy_path", "planned": 1, "testCaseIds": [], "status": "gap"}]}

Requirements:
${JSON.stringify(requirements.map(r => ({ id: r.id, text: r.text, category: r.category, priority: r.priority })), null, 2)}`
}

function buildGroundedCasesPrompt(
  requirements: Requirement[],
  coverage: CoverageCell[],
  startIndex: number,
  context?: { strategy?: string; plan?: string },
  options?: { focusInstructions?: string; automationFriendly?: boolean }
): string {
  const relevantCells = coverage.filter(
    c => c.status !== 'not_applicable' && requirements.some(r => r.id === c.requirementId)
  )
  const automationFriendlyRules = options?.automationFriendly ? `
AUTOMATION-FRIENDLY MODE (critical – these cases feed directly into automated Playwright generation):
- Each case must be a SELF-CONTAINED, end-to-end reproducible flow: start from a known, nameable entry point (e.g. "Navigate to the login page", "Navigate to /account/settings") and include EVERY intermediate navigation/setup/interaction step needed to reach the state under test – never assume the reader/automation is "already" somewhere unless a prior step in the SAME case put them there.
- "precondition" describes DATA/account state only (e.g. "user account exists with a verified email"), never UI navigation state – all navigation is explicit STEPS, not assumed context.
- Every step's "action" must be ONE concretely automatable browser interaction: navigate, click, fill, select, check, hover, or a single explicit wait/verify – never a vague action like "ensure the flow works" with no way to know how to reach it.
- The FINAL step's "expectedResult" is the actual test assertion; every step before it is scaffolding to reach that point.
` : ''
  return `You are a senior QA engineer writing production-grade test cases.

Write test cases for the requirements below, following the coverage plan exactly (one or more cases per planned requirement × scenario type combination).

STRICT RULES:
- Every test case MUST cite its requirement via "sourceRequirement": {"requirementId": "REQ-NNN", "snippet": "<the requirement's sourceSnippet>"}.
- Never test anything not present in the cited requirement.
- Each step tests ONE validation only – never combine multiple validations in one step.
- "testData" must contain concrete, specific values (real example emails, amounts, boundary numbers), never placeholders like "valid data".
- "expectedResult" must be specific and observable.
- 5-8 detailed steps per test case – NEVER fewer than 4. Include setup/navigation steps, the core action, and verification steps.
- Test case ids are sequential starting at TC-${String(startIndex).padStart(3, '0')}.
${context?.plan ? '- Align with the test plan context provided at the end.\n' : ''}${automationFriendlyRules}${options?.focusInstructions ? `\nUSER FOCUS INSTRUCTIONS: ${options.focusInstructions}\n` : ''}
Return ONLY valid JSON in this exact shape:
{"testCases": [{"id": "TC-001", "summary": "...", "issueType": "Test", "priority": "Critical|High|Medium|Low", "labels": "functional,happy_path", "testType": "Functional|Security|Performance|UI/UX", "precondition": "...", "steps": [{"stepNumber": 1, "action": "...", "testData": "...", "expectedResult": "..."}], "status": "Not Executed", "component": "...", "estimatedTime": "15m", "scenarioType": "happy_path|negative|edge_case|boundary|ui_ux|security|performance", "sourceRequirement": {"requirementId": "REQ-001", "snippet": "..."}}]}

Requirements:
${JSON.stringify(requirements, null, 2)}

Coverage plan to fulfil:
${JSON.stringify(relevantCells.map(c => ({ requirementId: c.requirementId, scenarioType: c.scenarioType, planned: c.planned })), null, 2)}
${context?.plan ? `\nTest plan context:\n${context.plan.slice(0, 3000)}` : ''}`
}

function buildExpandStepsPrompt(requirements: Requirement[], thinCases: TestCase[]): string {
  const reqIds = new Set(thinCases.map(tc => tc.sourceRequirement?.requirementId).filter(Boolean))
  const relevantReqs = requirements.filter(r => reqIds.has(r.id))
  return `You are a senior QA engineer. The test cases below are too shallow – rewrite EACH one with 5-8 detailed, executable steps while keeping everything else identical.

STRICT RULES:
- Keep the same "id", "summary", "scenarioType", and "sourceRequirement" for every case.
- Steps must include setup/navigation, the core action(s) split into single validations, and explicit verification steps.
- "testData" must contain concrete values (real example emails, amounts, boundary numbers), never placeholders.
- "expectedResult" must be specific and observable for every step.
- Only test behaviour present in the cited requirement.

Return ONLY valid JSON in this exact shape:
{"testCases": [{"id": "...", "summary": "...", "issueType": "Test", "priority": "...", "labels": "...", "testType": "...", "precondition": "...", "steps": [{"stepNumber": 1, "action": "...", "testData": "...", "expectedResult": "..."}], "status": "Not Executed", "component": "...", "estimatedTime": "...", "scenarioType": "...", "sourceRequirement": {"requirementId": "...", "snippet": "..."}}]}

Cited requirements for grounding:
${JSON.stringify(relevantReqs.map(r => ({ id: r.id, text: r.text, sourceSnippet: r.sourceSnippet })), null, 2)}

Test cases to expand:
${JSON.stringify(thinCases, null, 2)}`
}

function buildInteractionCasesPrompt(
  requirements: Requirement[],
  existingCases: TestCase[],
  startIndex: number,
  maxCases: number
): string {
  const existingSummaries = existingCases.map(tc => `${tc.id}: ${tc.summary}`)
  return `You are a senior QA engineer hunting for CROSS-REQUIREMENT bugs – the expensive defects that appear only when two features interact.

From the requirements below, identify up to ${maxCases} meaningful INTERACTIONS between two (or three) different requirements, and write one test case for each interaction. Examples of interaction patterns: state from one feature affecting another (session expiry during checkout), conflicting rules (discount + minimum order), shared resources (concurrent edits), ordering effects (delete then restore then edit).

STRICT RULES:
- Every case MUST involve at least TWO different requirements: cite the primary via "sourceRequirement" and ALL others via "relatedRequirementIds" (array of REQ ids).
- Only combine behaviours actually present in the requirements – do not invent features.
- Do NOT duplicate the existing test cases listed at the end.
- 5-8 detailed steps per case; concrete "testData" values; observable "expectedResult" per step.
- "scenarioType" should usually be "edge_case" or "negative".
- Ids sequential starting at TC-${String(startIndex).padStart(3, '0')}.
- If the requirements offer no meaningful interactions, return {"testCases": []}... but think hard first – return an empty list only when combinations genuinely make no sense.

Return ONLY valid JSON in this exact shape:
{"testCases": [{"id": "TC-001", "summary": "...", "issueType": "Test", "priority": "High", "labels": "interaction,edge_case", "testType": "Functional", "precondition": "...", "steps": [{"stepNumber": 1, "action": "...", "testData": "...", "expectedResult": "..."}], "status": "Not Executed", "component": "...", "estimatedTime": "15m", "scenarioType": "edge_case", "sourceRequirement": {"requirementId": "REQ-001", "snippet": "..."}, "relatedRequirementIds": ["REQ-004"]}]}

Requirements:
${JSON.stringify(requirements, null, 2)}

Existing test cases (do not duplicate):
${JSON.stringify(existingSummaries, null, 2)}`
}

function buildCritiquePrompt(requirements: Requirement[], testCases: TestCase[]): string {
  const compactCases = testCases.map(tc => ({
    id: tc.id,
    summary: tc.summary,
    scenarioType: tc.scenarioType,
    requirementId: tc.sourceRequirement?.requirementId || null,
    relatedRequirementIds: tc.relatedRequirementIds || undefined,
    steps: tc.steps.map(s => `${s.action} => ${s.expectedResult}`)
  }))
  return `You are a skeptical senior QA reviewer auditing AI-generated test cases against their source requirements.

For EACH test case, return a verdict in JSON:
- "pass": the steps and expected results are entailed by the cited requirement(s) – for cases with "relatedRequirementIds", judge against the COMBINATION of all cited requirements.
- "ungrounded": the case tests behaviour NOT present in the cited requirement(s) (or cites no/wrong requirement).
- "fix": the case is grounded but the citation or a detail is wrong – explain in "note".

Return ONLY valid JSON in this exact shape:
{"verdicts": [{"caseId": "TC-001", "verdict": "pass", "note": ""}]}

Requirements:
${JSON.stringify(requirements.map(r => ({ id: r.id, text: r.text, sourceSnippet: r.sourceSnippet })), null, 2)}

Test cases to audit:
${JSON.stringify(compactCases, null, 2)}`
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface ExtractStageResult {
  requirements: Requirement[]
  warnings: string[]
}

// Stage 1 (standalone so the UI can pause for human review of the extracted
// requirements before any test cases are generated on top of them).
export async function extractRequirementsStage(cfg: GroundedConfig): Promise<ExtractStageResult> {
  const { provider, apiKey, input, mediaFiles, isVisual, onProgress } = cfg
  // Extraction is mechanical – route to the cheaper utility model when set
  const model = cfg.utilityModel || cfg.model
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  const repair = aiService.makeRepairFn(provider, apiKey, model)
  const warnings: string[] = []

  const call = (prompt: string, opts: GenOptions, media?: MediaFileData[]) =>
    aiService.complete(provider, apiKey, model, prompt, opts, media)

  // Extract requirements with verbatim citations. Large documents are
  // processed section-by-section so the output token cap never silently
  // truncates the requirement list (root cause of "6 cases from a 1MB spec").
  progress({ pass: 'extract', status: 'running' })
  const sections = splitIntoSections(input)
  if (sections.length > MAX_SECTIONS) {
    warnings.push(
      `Document is very large (${sections.length} sections) – only the first ${MAX_SECTIONS} sections were analyzed. Consider splitting the spec.`
    )
    sections.length = MAX_SECTIONS
  }

  const requirements: Requirement[] = []
  const seenReqTexts = new Set<string>()
  for (const [index, section] of sections.entries()) {
    checkAborted(cfg)
    if (sections.length > 1) {
      progress({ pass: 'extract', status: 'running', detail: `section ${index + 1}/${sections.length}` })
    }
    const extractRaw = await call(
      buildExtractPrompt(section, !!isVisual, { index: index + 1, total: sections.length }, cfg.scopeInstructions),
      withSignal({ json: true, temperature: 0.1, maxTokens }, cfg),
      index === 0 ? mediaFiles : undefined
    )
    const parsed = await parseWithRepair(extractRaw, RequirementListSchema, repair)
    for (const req of parsed.requirements) {
      const key = req.text.toLowerCase().replace(/\s+/g, ' ').trim()
      if (seenReqTexts.has(key)) continue
      seenReqTexts.add(key)
      requirements.push(req)
    }
  }
  // Renumber sequentially across sections (models restart at REQ-001 per call)
  requirements.forEach((req, i) => { req.id = `REQ-${String(i + 1).padStart(3, '0')}` })

  if (!isVisual) {
    for (const req of requirements) {
      req.grounded = verifySnippet(input, req.sourceSnippet)
    }
    const ungroundedReqs = requirements.filter(r => r.grounded === false)
    if (ungroundedReqs.length > 0) {
      warnings.push(
        `${ungroundedReqs.length} requirement(s) could not be verified verbatim against the source (${ungroundedReqs.map(r => r.id).join(', ')}) – review them before trusting their test cases.`
      )
    }
  }
  progress({ pass: 'extract', status: 'done', detail: `${requirements.length} requirements` })
  return { requirements, warnings }
}

// ── Requirement testability analysis ──────────────────────────────────────────

function buildTestabilityPrompt(chunk: Requirement[], fullSet: Requirement[]): string {
  return `You are a skeptical senior QA analyst applying INVEST and testability heuristics.
A requirement is TESTABLE only if it has: a clear actor, an observable/measurable
outcome, is atomic (one behaviour), is unambiguous, and states WHAT to verify (not HOW).

For EACH requirement in "Requirements to analyze" return:
- "verdict": "testable" | "weak" | "untestable"
- "score": 0–100 (how confidently a tester could verify it as written)
- "issues": zero or more of EXACTLY these values:
  ["ambiguous","unmeasurable","no_acceptance_criteria","compound","contradiction","implementation_detail","missing_actor"]
- "rationale": ONE short sentence explaining the verdict
- "suggestedRewrite": for "weak"/"untestable", a rewritten, directly-verifiable phrasing (omit for "testable")

Rules:
- "contradiction" ONLY when the requirement conflicts with another in the "Full requirement set" context below.
- Do NOT invent issue values outside the list. Do NOT rewrite a "testable" requirement.
- Analyze ONLY the requirements in "Requirements to analyze"; the full set is context for contradiction checks.

Return ONLY valid JSON in this exact shape:
{"analyses":[{"requirementId":"REQ-001","verdict":"weak","score":55,"issues":["ambiguous"],"rationale":"...","suggestedRewrite":"..."}]}

Requirements to analyze:
${JSON.stringify(chunk.map(r => ({ id: r.id, text: r.text })), null, 2)}

Full requirement set (context for contradiction detection only):
${JSON.stringify(fullSet.map(r => ({ id: r.id, text: r.text })), null, 2)}`
}

export interface TestabilityStageResult {
  analyses: RequirementAnalysis[]
  warnings: string[]
}

// Advisory quality pass over the extracted requirements. Judgment work (like
// critique), so it runs on the MAIN model, not the utility model. Best-effort:
// a failure returns whatever was analyzed plus a warning – it must never block
// the human review step it feeds.
export async function analyzeRequirementTestability(
  cfg: GroundedConfig,
  requirements: Requirement[]
): Promise<TestabilityStageResult> {
  const { provider, apiKey, model, onProgress } = cfg
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  const repair = aiService.makeRepairFn(provider, apiKey, model)
  const analyses: RequirementAnalysis[] = []
  const warnings: string[] = []

  if (requirements.length === 0) return { analyses, warnings }

  progress({ pass: 'analyze', status: 'running' })
  // Chunk so the output budget holds for large sets; the full list is always
  // passed as context so contradiction detection spans every requirement.
  for (let i = 0; i < requirements.length; i += PLAN_CHUNK_SIZE) {
    checkAborted(cfg)
    const chunk = requirements.slice(i, i + PLAN_CHUNK_SIZE)
    if (requirements.length > PLAN_CHUNK_SIZE) {
      progress({ pass: 'analyze', status: 'running', detail: `requirements ${i + 1}-${i + chunk.length}/${requirements.length}` })
    }
    try {
      const raw = await aiService.complete(
        provider, apiKey, model,
        buildTestabilityPrompt(chunk, requirements),
        withSignal({ json: true, temperature: 0, maxTokens }, cfg)
      )
      const parsed = await parseWithRepair(raw, TestabilityReportSchema, repair)
      analyses.push(...parsed.analyses)
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) throw err
      warnings.push(`Testability analysis skipped for requirements ${i + 1}-${i + chunk.length} (${err.message}).`)
    }
  }
  progress({ pass: 'analyze', status: 'done', detail: `${analyses.length} analyzed` })
  return { analyses, warnings }
}

// Stage 2: plan → generate → gap-fill → expand → critique, over a (possibly
// human-reviewed) requirement list.
export interface GenerateOptions {
  focusInstructions?: string
  automationFriendly?: boolean
}

// Snapshot of pipeline progress captured when a stage fails outright (as
// opposed to gap-fill/expand/critique, which already degrade gracefully).
// Lets the UI offer "pick a different model and resume" instead of forcing
// a full restart from the reviewed requirements.
export interface GenerationCheckpoint {
  stage: 'plan' | 'generate'
  requirements: Requirement[]
  coverage: CoverageCell[]
  testCases: TestCase[]
  /** Chunk/group index to resume from within the stalled stage. */
  nextIndex: number
  warnings: string[]
  context?: { strategy?: string; plan?: string }
  options?: GenerateOptions
}

export class PipelineStallError extends Error {
  checkpoint: GenerationCheckpoint
  constructor(message: string, checkpoint: GenerationCheckpoint) {
    super(message)
    this.name = 'PipelineStallError'
    this.checkpoint = checkpoint
  }
}

async function runGenerationFromCheckpoint(
  cfg: GroundedConfig,
  requirements: Requirement[],
  warnings: string[],
  options: GenerateOptions | undefined,
  resumeFrom?: { stage: 'plan' | 'generate'; coverage: CoverageCell[]; testCases: TestCase[]; nextIndex: number }
): Promise<GroundedResult> {
  const { provider, apiKey, model, mediaFiles, context, onProgress } = cfg
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  // Stream a defensive copy so the UI can't mutate the in-flight working array.
  const emitPartial = (cases: TestCase[]) => cfg.onPartialCases?.([...cases])
  const repair = aiService.makeRepairFn(provider, apiKey, model)

  const call = (prompt: string, opts: GenOptions, media?: MediaFileData[]) =>
    aiService.complete(provider, apiKey, model, prompt, opts, media)

  // Pass 2: coverage plan (chunked – planning 60 requirements in one call
  // would blow the output budget and drop cells). Planning is mechanical –
  // route to the cheaper utility model when configured.
  const planModel = cfg.utilityModel || model
  const planRepair = aiService.makeRepairFn(provider, apiKey, planModel)
  const coverage: CoverageCell[] = resumeFrom ? [...resumeFrom.coverage] : []
  const planStartAt = resumeFrom?.stage === 'plan' ? resumeFrom.nextIndex : 0

  if (!resumeFrom || resumeFrom.stage === 'plan') {
    progress({ pass: 'plan', status: 'running' })
    for (let i = planStartAt; i < requirements.length; i += PLAN_CHUNK_SIZE) {
      checkAborted(cfg)
      const reqChunk = requirements.slice(i, i + PLAN_CHUNK_SIZE)
      if (requirements.length > PLAN_CHUNK_SIZE) {
        progress({ pass: 'plan', status: 'running', detail: `requirements ${i + 1}-${i + reqChunk.length}/${requirements.length}` })
      }
      try {
        const planRaw = await aiService.complete(
          provider, apiKey, planModel,
          buildCoveragePlanPrompt(reqChunk, options?.focusInstructions),
          withSignal({ json: true, temperature: 0.2, maxTokens }, cfg)
        )
        const parsed = await parseWithRepair(planRaw, CoveragePlanSchema, planRepair)
        coverage.push(...parsed.coverage)
      } catch (err: any) {
        if (err instanceof GenerationAbortedError) throw err
        progress({ pass: 'plan', status: 'error', detail: 'stalled – pick a model to resume' })
        throw new PipelineStallError(`Coverage planning stalled: ${err.message}`, {
          stage: 'plan', requirements, coverage, testCases: [], nextIndex: i, warnings, context, options
        })
      }
    }
    progress({ pass: 'plan', status: 'done', detail: `${coverage.length} coverage cells` })
  }

  // Pass 3: generate grounded cases. Requirements are grouped so no single
  // call is asked for more cases than its output budget can express in full
  // detail – over-stuffed calls are why models compress to 2-3 shallow steps.
  const plannedCasesByReq = new Map<string, number>()
  for (const cell of coverage) {
    if (cell.status === 'not_applicable' || cell.planned <= 0) continue
    plannedCasesByReq.set(cell.requirementId, (plannedCasesByReq.get(cell.requirementId) || 0) + cell.planned)
  }

  const groups: Requirement[][] = []
  let currentGroup: Requirement[] = []
  let currentBudget = 0
  for (const req of requirements) {
    const cost = plannedCasesByReq.get(req.id) ?? 1
    if (
      currentGroup.length > 0 &&
      (currentBudget + cost > MAX_PLANNED_CASES_PER_CALL || currentGroup.length >= MAX_REQS_PER_GENERATE_CALL)
    ) {
      groups.push(currentGroup)
      currentGroup = []
      currentBudget = 0
    }
    currentGroup.push(req)
    currentBudget += cost
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  const generateStartAt = resumeFrom?.stage === 'generate' ? resumeFrom.nextIndex : 0
  let testCases: TestCase[] = resumeFrom?.stage === 'generate' ? [...resumeFrom.testCases] : []

  progress({ pass: 'generate', status: 'running' })
  for (let index = generateStartAt; index < groups.length; index++) {
    checkAborted(cfg)
    const group = groups[index]
    if (groups.length > 1) {
      progress({ pass: 'generate', status: 'running', detail: `batch ${index + 1}/${groups.length}` })
    }
    try {
      const genRaw = await call(
        buildGroundedCasesPrompt(group, coverage, testCases.length + 1, context, options),
        withSignal({ json: true, temperature: 0.4, maxTokens }, cfg),
        index === 0 ? mediaFiles : undefined
      )
      const parsed = await parseWithRepair(genRaw, TestCasesPayloadSchema, repair)
      testCases.push(...(parsed as TestCase[]))
      emitPartial(testCases)
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) throw err
      progress({ pass: 'generate', status: 'error', detail: 'stalled – pick a model to resume' })
      throw new PipelineStallError(`Test case generation stalled: ${err.message}`, {
        stage: 'generate', requirements, coverage, testCases, nextIndex: index, warnings, context, options
      })
    }
  }

  // Pass 3b: gap-fill – one targeted retry for planned combinations the model
  // skipped, so the delivered suite matches the coverage plan.
  const generatedKeys = new Set(testCases.map(tc => `${tc.sourceRequirement?.requirementId}|${tc.scenarioType}`))
  const missingCells = coverage.filter(
    c => c.status !== 'not_applicable' && c.planned > 0 && !generatedKeys.has(`${c.requirementId}|${c.scenarioType}`)
  )
  if (missingCells.length > 0 && !cfg.signal?.aborted) {
    progress({ pass: 'generate', status: 'running', detail: `filling ${missingCells.length} coverage gap(s)` })
    const gapCells = missingCells.slice(0, MAX_PLANNED_CASES_PER_CALL)
    const gapReqIds = new Set(gapCells.map(c => c.requirementId))
    const gapReqs = requirements.filter(r => gapReqIds.has(r.id))
    try {
      const gapRaw = await call(
        buildGroundedCasesPrompt(gapReqs, gapCells, testCases.length + 1, context, options),
        withSignal({ json: true, temperature: 0.4, maxTokens }, cfg)
      )
      const gapParsed = await parseWithRepair(gapRaw, TestCasesPayloadSchema, repair)
      testCases.push(...(gapParsed as TestCase[]))
      emitPartial(testCases)
      if (missingCells.length > gapCells.length) {
        warnings.push(`${missingCells.length - gapCells.length} planned coverage cell(s) remain unfilled – use "Add More Test Cases" or regenerate.`)
      }
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) throw err
      warnings.push(`Gap-fill pass failed (${err.message}) – ${missingCells.length} planned coverage cell(s) remain gaps.`)
    }
  }

  // Renumber case ids sequentially (models restart numbering per batch)
  testCases = testCases.map((tc, i) => ({ ...tc, id: `TC-${String(i + 1).padStart(3, '0')}` }))

  // Pass 3c: step expansion – rewrite shallow cases (< MIN_STEPS_PER_CASE
  // steps) with full setup/action/verification detail instead of shipping
  // skeletons the user has to rework.
  const thinCases = testCases.filter(tc => (tc.steps?.length || 0) < MIN_STEPS_PER_CASE)
  if (thinCases.length > 0 && !cfg.signal?.aborted) {
    progress({ pass: 'generate', status: 'running', detail: `expanding ${thinCases.length} shallow case(s)` })
    for (let i = 0; i < thinCases.length; i += EXPAND_BATCH_SIZE) {
      if (cfg.signal?.aborted) break
      const batch = thinCases.slice(i, i + EXPAND_BATCH_SIZE)
      try {
        const expandRaw = await call(
          buildExpandStepsPrompt(requirements, batch),
          withSignal({ json: true, temperature: 0.3, maxTokens }, cfg)
        )
        const expanded = await parseWithRepair(expandRaw, TestCasesPayloadSchema, repair)
        const expandedById = new Map((expanded as TestCase[]).map(tc => [tc.id, tc]))
        testCases = testCases.map(tc => {
          const richer = expandedById.get(tc.id)
          if (richer && (richer.steps?.length || 0) > (tc.steps?.length || 0)) {
            return { ...richer, sourceRequirement: richer.sourceRequirement ?? tc.sourceRequirement }
          }
          return tc
        })
      } catch (err: any) {
        if (err instanceof GenerationAbortedError) break
        warnings.push(`Step-expansion pass failed for ${batch.length} case(s) (${err.message}) – they may need manual detail.`)
      }
    }
  }
  progress({ pass: 'generate', status: 'done', detail: `${testCases.length} test cases` })

  // Pass 4: self-critique – flag ungrounded cases instead of trusting blindly.
  const { kept, flagged } = await auditCases(cfg, requirements, testCases, warnings)

  return {
    requirements,
    coverage: finalizeCoverage(coverage, requirements, kept),
    testCases: kept,
    flagged,
    warnings
  }
}

// Stage 2 entry point: plan → generate → gap-fill → expand → critique over a
// (possibly human-reviewed) requirement list. Throws PipelineStallError
// (rather than a plain error) if the plan or generate pass fails outright,
// carrying a checkpoint the caller can resume from with a different model –
// gap-fill/expand/critique already degrade gracefully and never stall.
export async function generateFromRequirements(
  cfg: GroundedConfig,
  requirements: Requirement[],
  priorWarnings: string[] = [],
  options?: GenerateOptions
): Promise<GroundedResult> {
  return runGenerationFromCheckpoint(cfg, requirements, [...priorWarnings], options)
}

// Resumes a stalled generation using a checkpoint from a caught
// PipelineStallError – typically with a different provider/model in `cfg`
// than the run that stalled. Picks up at the exact chunk/group that failed
// instead of re-running completed work.
export async function resumeGeneration(
  cfg: GroundedConfig,
  checkpoint: GenerationCheckpoint
): Promise<GroundedResult> {
  return runGenerationFromCheckpoint(
    cfg,
    checkpoint.requirements,
    checkpoint.warnings,
    checkpoint.options,
    { stage: checkpoint.stage, coverage: checkpoint.coverage, testCases: checkpoint.testCases, nextIndex: checkpoint.nextIndex }
  )
}

// Full pipeline in one shot (used by workflow mode and the eval harness;
// the interactive cases flow runs the two stages separately with a human
// review of requirements in between).
export async function runGroundedGeneration(cfg: GroundedConfig): Promise<GroundedResult> {
  const extracted = await extractRequirementsStage(cfg)
  return generateFromRequirements(cfg, extracted.requirements, extracted.warnings)
}

// Critique audit shared by the main pipeline and gap-driven Add More.
// A critique failure must not destroy the generated work.
async function auditCases(
  cfg: GroundedConfig,
  requirements: Requirement[],
  testCases: TestCase[],
  warnings: string[]
): Promise<{ kept: TestCase[]; flagged: TestCase[] }> {
  const { provider, apiKey, model, onProgress } = cfg
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  const repair = aiService.makeRepairFn(provider, apiKey, model)

  const flagged: TestCase[] = []
  let kept = testCases
  if (cfg.signal?.aborted) {
    warnings.push('Self-critique pass skipped — generation was stopped before it ran; test cases are shown unaudited.')
    return { kept, flagged }
  }
  progress({ pass: 'critique', status: 'running' })
  try {
    const critiqueRaw = await aiService.complete(
      provider, apiKey, model,
      buildCritiquePrompt(requirements, testCases),
      withSignal({ json: true, temperature: 0, maxTokens }, cfg)
    )
    const { verdicts } = await parseWithRepair(critiqueRaw, CritiqueResultSchema, repair)
    const verdictById = new Map(verdicts.map(v => [v.caseId, v]))

    kept = []
    for (const tc of testCases) {
      const verdict = verdictById.get(tc.id)
      if (verdict?.verdict === 'ungrounded') {
        flagged.push({ ...tc, grounded: false, critiqueNote: verdict.note || 'Not grounded in the cited requirement' })
      } else if (verdict?.verdict === 'fix') {
        kept.push({ ...tc, grounded: true, critiqueNote: verdict.note || '' })
      } else {
        kept.push({ ...tc, grounded: true })
      }
    }
    progress({
      pass: 'critique',
      status: 'done',
      detail: flagged.length > 0 ? `${flagged.length} case(s) flagged as ungrounded` : 'all cases grounded'
    })
  } catch (err: any) {
    warnings.push(`Self-critique pass failed (${err.message}) – test cases are shown unaudited.`)
    progress({ pass: 'critique', status: 'error', detail: 'skipped – cases unaudited' })
  }
  return { kept, flagged }
}

export interface GapCasesResult {
  testCases: TestCase[]
  flagged: TestCase[]
  noGaps: boolean
  warnings: string[]
}

// Gap-driven "Add More Cases": generates cases ONLY for coverage cells that
// are planned but under-filled, grounded and audited like the main pipeline –
// instead of the legacy "invent something different" prompt.
export async function generateGapCases(
  cfg: GroundedConfig,
  requirements: Requirement[],
  coverage: CoverageCell[],
  existingCases: TestCase[]
): Promise<GapCasesResult> {
  const { provider, apiKey, model, context, onProgress } = cfg
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  const repair = aiService.makeRepairFn(provider, apiKey, model)
  const warnings: string[] = []

  // Which planned cells are still under-filled by the current suite?
  const countByKey = new Map<string, number>()
  for (const tc of existingCases) {
    const key = `${tc.sourceRequirement?.requirementId}|${tc.scenarioType}`
    countByKey.set(key, (countByKey.get(key) || 0) + 1)
  }
  const unmetCells = coverage.filter(
    c =>
      c.status !== 'not_applicable' &&
      c.planned > 0 &&
      (countByKey.get(`${c.requirementId}|${c.scenarioType}`) || 0) < c.planned
  )
  if (unmetCells.length === 0) {
    return { testCases: [], flagged: [], noGaps: true, warnings }
  }

  // Bound cost per click: at most two generation calls' worth of cells.
  const cells = unmetCells.slice(0, MAX_PLANNED_CASES_PER_CALL * 2)
  if (unmetCells.length > cells.length) {
    warnings.push(`${unmetCells.length - cells.length} more gap(s) remain – click "Add More Test Cases" again to continue filling.`)
  }

  let maxNum = 0
  for (const tc of existingCases) {
    const match = tc.id.match(/TC-(\d+)/)
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
  }

  let newCases: TestCase[] = []
  for (let i = 0; i < cells.length; i += MAX_PLANNED_CASES_PER_CALL) {
    const cellChunk = cells.slice(i, i + MAX_PLANNED_CASES_PER_CALL)
    const reqIds = new Set(cellChunk.map(c => c.requirementId))
    const reqs = requirements.filter(r => reqIds.has(r.id))
    progress({ pass: 'generate', status: 'running', detail: `filling ${cellChunk.length} coverage gap(s)` })
    if (cfg.signal?.aborted) throw new GenerationAbortedError()
    const genRaw = await aiService.complete(
      provider, apiKey, model,
      buildGroundedCasesPrompt(reqs, cellChunk, maxNum + newCases.length + 1, context),
      withSignal({ json: true, temperature: 0.4, maxTokens }, cfg)
    )
    const parsed = await parseWithRepair(genRaw, TestCasesPayloadSchema, repair)
    newCases.push(...(parsed as TestCase[]))
  }

  // Renumber new cases to continue after the existing suite
  newCases = newCases.map((tc, i) => ({ ...tc, id: `TC-${String(maxNum + i + 1).padStart(3, '0')}` }))

  // Expand shallow cases, then audit – same quality bar as the main pipeline
  const thin = newCases.filter(tc => (tc.steps?.length || 0) < MIN_STEPS_PER_CASE)
  if (thin.length > 0) {
    progress({ pass: 'generate', status: 'running', detail: `expanding ${thin.length} shallow case(s)` })
    try {
      const expandRaw = await aiService.complete(
        provider, apiKey, model,
        buildExpandStepsPrompt(requirements, thin),
        withSignal({ json: true, temperature: 0.3, maxTokens }, cfg)
      )
      const expanded = await parseWithRepair(expandRaw, TestCasesPayloadSchema, repair)
      const expandedById = new Map((expanded as TestCase[]).map(tc => [tc.id, tc]))
      newCases = newCases.map(tc => {
        const richer = expandedById.get(tc.id)
        if (richer && (richer.steps?.length || 0) > (tc.steps?.length || 0)) {
          return { ...richer, sourceRequirement: richer.sourceRequirement ?? tc.sourceRequirement }
        }
        return tc
      })
    } catch (err: any) {
      warnings.push(`Step-expansion failed for ${thin.length} new case(s) (${err.message}).`)
    }
  }
  progress({ pass: 'generate', status: 'done', detail: `${newCases.length} gap-filling case(s)` })

  const { kept, flagged } = await auditCases(cfg, requirements, newCases, warnings)
  return { testCases: kept, flagged, noGaps: false, warnings }
}

const MAX_INTERACTION_CASES = 8

export interface InteractionCasesResult {
  testCases: TestCase[]
  flagged: TestCase[]
  noInteractions: boolean
  warnings: string[]
}

// Cross-requirement scenarios: the expensive bugs live where two features
// meet. User-triggered (one generate + one critique call per click).
export async function generateInteractionCases(
  cfg: GroundedConfig,
  requirements: Requirement[],
  existingCases: TestCase[]
): Promise<InteractionCasesResult> {
  const { provider, apiKey, model, onProgress } = cfg
  const maxTokens = cfg.maxTokens ?? 8000
  const progress = (p: PipelineProgress) => onProgress?.(p)
  const repair = aiService.makeRepairFn(provider, apiKey, model)
  const warnings: string[] = []

  if (requirements.length < 2) {
    return { testCases: [], flagged: [], noInteractions: true, warnings }
  }

  let maxNum = 0
  for (const tc of existingCases) {
    const match = tc.id.match(/TC-(\d+)/)
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
  }

  progress({ pass: 'generate', status: 'running', detail: 'hunting cross-requirement interactions' })
  const raw = await aiService.complete(
    provider, apiKey, model,
    buildInteractionCasesPrompt(requirements, existingCases, maxNum + 1, MAX_INTERACTION_CASES),
    { json: true, temperature: 0.5, maxTokens }
  )

  // An empty testCases array is a legitimate "no interactions found" answer –
  // probe before schema validation (which requires >= 1 case).
  let parsed: TestCase[]
  try {
    const probe: any = extractJson(raw)
    if (probe && Array.isArray(probe.testCases) && probe.testCases.length === 0) {
      progress({ pass: 'generate', status: 'done', detail: 'no meaningful interactions found' })
      return { testCases: [], flagged: [], noInteractions: true, warnings }
    }
    parsed = (await parseWithRepair(raw, TestCasesPayloadSchema, repair)) as TestCase[]
  } catch (err: any) {
    throw new Error(`Interaction case generation failed: ${err.message}`)
  }

  // Keep only genuine interactions (≥ 2 distinct requirements cited)
  const interactions = parsed.filter(tc => {
    const primary = tc.sourceRequirement?.requirementId
    const related = (tc.relatedRequirementIds || []).filter(id => id && id !== primary)
    return primary && related.length > 0
  })
  if (interactions.length < parsed.length) {
    warnings.push(`${parsed.length - interactions.length} generated case(s) only cited one requirement and were dropped – interaction cases must span at least two.`)
  }
  if (interactions.length === 0) {
    return { testCases: [], flagged: [], noInteractions: true, warnings }
  }

  // Renumber to continue after existing suite
  const renumbered = interactions.map((tc, i) => ({ ...tc, id: `TC-${String(maxNum + i + 1).padStart(3, '0')}` }))
  progress({ pass: 'generate', status: 'done', detail: `${renumbered.length} interaction case(s)` })

  const { kept, flagged } = await auditCases(cfg, requirements, renumbered, warnings)
  return { testCases: kept, flagged, noInteractions: false, warnings }
}

// Recompute coverage cells from the cases that actually got generated/kept.
export function finalizeCoverage(
  planned: CoverageCell[],
  requirements: Requirement[],
  testCases: TestCase[]
): CoverageCell[] {
  const plannedByKey = new Map(planned.map(c => [`${c.requirementId}|${c.scenarioType}`, c]))
  const cells: CoverageCell[] = []

  for (const req of requirements) {
    for (const scenarioType of SCENARIO_TYPES as ScenarioType[]) {
      const key = `${req.id}|${scenarioType}`
      const plan = plannedByKey.get(key)
      const caseIds = testCases
        .filter(tc => tc.sourceRequirement?.requirementId === req.id && tc.scenarioType === scenarioType)
        .map(tc => tc.id)

      let status: CoverageCell['status']
      if (caseIds.length > 0) {
        status = plan && plan.planned > caseIds.length ? 'partial' : 'covered'
      } else if (!plan || plan.status === 'not_applicable') {
        status = 'not_applicable'
      } else {
        status = 'gap'
      }

      cells.push({
        requirementId: req.id,
        scenarioType,
        planned: plan?.planned ?? 0,
        testCaseIds: caseIds,
        status
      })
    }
  }
  return cells
}
