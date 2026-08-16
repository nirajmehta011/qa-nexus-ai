import axios from 'axios'
import { AIProvider } from '../context/SettingsContext'
import { parseWithRepair, extractJson, type RepairFn } from './jsonParser'
import {
  TestCasesPayloadSchema,
  ConfidenceReportSchema,
  type ConfidenceAssessment,
  type SourceCitation
} from './schemas'
import { extractErrorMessage } from './errorUtils'

const API_BASE =
  (import.meta as any).env?.VITE_API_URL ||
  (typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001/api'
    : '/api')

export interface AIModel {
  id: string
  name: string
}

// Per-call generation options forwarded to the server proxy (which clamps them).
export interface GenOptions {
  temperature?: number
  maxTokens?: number
  json?: boolean
  /** Lets a caller cancel an in-flight request — wired to the Stop button. */
  signal?: AbortSignal
}

/** Thrown when a request is cancelled via GenOptions.signal — never a failure to retry or fail over from. */
export class GenerationAbortedError extends Error {
  constructor() {
    super('Generation stopped.')
    this.name = 'GenerationAbortedError'
  }
}

function buildGenParams(opts?: GenOptions) {
  if (!opts) return {}
  return {
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.json && { responseFormat: 'json' as const })
  }
}

export interface MediaFileData {
  mimeType: string
  base64: string
}

/** Normalised requirement input, whatever the source (URL / doc / Jira). */
export interface SpecInput {
  key: string
  summary: string
  description: string
  priority: string
  /** Human-readable provenance shown in the UI, e.g. "Jira PROJ-12". */
  source: string
}

export interface TestStep {
  stepNumber: number
  action: string
  testData: string
  expectedResult: string
}

export interface TestCase {
  id: string
  summary: string
  issueType: string
  priority: string
  labels: string
  testType: string
  precondition: string
  steps: TestStep[]
  status: string
  component: string
  estimatedTime: string
  scenarioType: 'happy_path' | 'negative' | 'edge_case' | 'boundary' | 'ui_ux' | 'security' | 'performance'
  // Traceability – present for grounded-pipeline output, absent for CSV imports
  // and the single-pass flow.
  sourceRequirement?: SourceCitation
  /** Interaction cases span multiple requirements: primary above, the rest here. */
  relatedRequirementIds?: string[]
  grounded?: boolean
  critiqueNote?: string
  confidence?: Partial<ConfidenceAssessment>
}

export interface PlaywrightAutomationFile {
  filename: string
  code: string
}

export interface PlaywrightAutomationData {
  readme: string
  packageJson: string
  tsconfigJson: string
  playwrightConfig: string
  testFiles: PlaywrightAutomationFile[]
  /** True when the suite was generated against an uploaded framework. */
  frameworkAware: boolean
  notes?: string
}

export interface MoreTestCasesResponse {
  testCases: TestCase[]
  noMoreCases: boolean
}

export const GROQ_DEFAULT_MODELS: AIModel[] = [
  { id: 'llama-3.3-70b-versatile', name: 'LLaMA 3.3 70B Versatile' },
  { id: 'llama-3.1-8b-instant', name: 'LLaMA 3.1 8B Instant' },
  { id: 'llama3-70b-8192', name: 'LLaMA 3 70B (8192)' },
  { id: 'gemma2-9b-it', name: 'Gemma 2 9B IT' }
]

export const OPENROUTER_DEFAULT_MODELS: AIModel[] = [
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
  { id: 'meta-llama/llama-3.1-70b-instruct', name: 'LLaMA 3.1 70B Instruct' }
]

export const GEMINI_DEFAULT_MODELS: AIModel[] = [
  { id: 'gemini-flash-latest', name: 'Gemini Flash (latest)' },
  { id: 'gemini-flash-lite-latest', name: 'Gemini Flash Lite (latest)' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'gemini-pro-latest', name: 'Gemini Pro (latest)' }
]

export const OPENAI_DEFAULT_MODELS: AIModel[] = [
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }
]

// ─── Prompts ─────────────────────────────────────────────────────────────────

const TEST_CASE_SCHEMA_BLOCK = `[
  {
    "id": "TC-001",
    "summary": "Verify [specific action under specific condition]",
    "issueType": "Test",
    "priority": "Critical",
    "labels": "functional,smoke",
    "testType": "Functional",
    "precondition": "[Preconditions]",
    "scenarioType": "happy_path",
    "component": "[Module / Feature]",
    "estimatedTime": "15m",
    "steps": [
      {
        "stepNumber": 1,
        "action": "Launch the application URL in the browser",
        "testData": "https://example.com/login",
        "expectedResult": "Application loads successfully, showing the login form without console errors."
      },
      {
        "stepNumber": 2,
        "action": "Verify visibility, placeholder text, and focus state of the Username field",
        "testData": "N/A",
        "expectedResult": "Username field is visible, placeholder reads 'Enter your username', focus outline appears on click."
      },
      {
        "stepNumber": 3,
        "action": "Enter a valid username into the Username field",
        "testData": "qa_architect_user",
        "expectedResult": "Field accepts the input and renders the text clearly."
      },
      {
        "stepNumber": 4,
        "action": "Click the Login button",
        "testData": "N/A",
        "expectedResult": "Button shows a spinner, becomes disabled, and issues the authentication API call."
      },
      {
        "stepNumber": 5,
        "action": "Verify response status and redirect to the Dashboard",
        "testData": "N/A",
        "expectedResult": "API responds 200, session is established, Dashboard renders."
      }
    ],
    "status": "Not Executed"
  }
]`

const QA_ARCHITECT_ROLE = `You are a Senior QA Architect and SDET with 12+ years of experience testing production web applications — the kind of engineer other testers ask to review their test plans. Write the way that engineer writes: precise, concrete, zero filler.

Your objective is MAXIMUM COVERAGE, not the minimum number of test cases. Never combine multiple validations into one step — every click, field, message, state change and UI element is validated separately.

GROUNDING — THE SINGLE MOST IMPORTANT RULE:
Every test case must be traceable to something actually stated or clearly implied by the specification below. Do NOT invent screens, fields, buttons, flows, or business rules the spec never mentions. If you are tempted to test a feature "because most apps have one," stop — that is hallucination, not coverage. When the spec is genuinely silent on a relevant detail (e.g. a password's exact minimum length), write the scenario but state your assumption plainly in the step or precondition text rather than inventing a specific unstated number as if it were fact.

COVER ALL OF THE FOLLOWING THAT THE SPEC ACTUALLY MAKES APPLICABLE (skip categories the spec gives no basis for):
- Functional: create, edit, delete, save, update, cancel, search, filter, sort, pagination, navigation, import/export, upload/download, refresh, session timeout, logout.
- UI validation: labels, copy, alignment, capitalization, button states (enabled/disabled/hover/focus), placeholders, character limits, mandatory indicators, trim/paste behaviour, dropdown defaults and keyboard navigation, checkbox/radio semantics, date pickers, table headers/sorting/pagination, links, toasts, modals, tooltips.
- Negative: empty fields, invalid input, special characters, over-long strings, duplicates, SQL injection and XSS payloads, invalid file types and sizes, session expiry, browser refresh, double submission, network interruption.
- Boundary: minimum, maximum, below minimum, above maximum, null, empty.
- Cross-browser and responsive: Chrome/Firefox/Safari/Edge; mobile/tablet/desktop; portrait/landscape.
- Accessibility: tab order, focus management, keyboard operation, screen-reader labels, colour contrast, ARIA attributes.
- Performance: page load, spinner visibility, API latency, refresh behaviour.
- Security: authentication, authorization, session management, URL manipulation, CSRF, cookie flags.
- API: request payload, response code, response schema, error responses, timeout and retry handling.`

const GRANULARITY_RULE = `CRITICAL RULE ON STEP GRANULARITY: write highly detailed, end-to-end steps a tester unfamiliar with the app could execute without guessing. Do not compress multiple actions or checks into one step. Each test case must have between 8 and 30 steps, each representing exactly ONE atomic interaction or validation — never fewer than 8; a 3-4 step case is not acceptable output.
Every step's "action" must name the exact UI element and interaction (e.g. "Click the 'Submit Order' button", not "submit the form"), and every "expectedResult" must state an observable, verifiable outcome (not "it works" or "success").
Before finalizing, do a second pass and add missed scenarios, hidden validations, field-level checks, state-transition validations and error handling.`

const JSON_ONLY = `Output ONLY the raw JSON array. Start with [ and end with ]. No markdown fences, no commentary before or after.`

function focusBlock(focusInstructions?: string): string {
  if (!focusInstructions?.trim()) return ''
  return `\n### SCOPE — READ CAREFULLY\nThe user wants this generation limited to the following. Do NOT generate cases outside this scope, even if the specification mentions other features:\n${focusInstructions.trim()}\n`
}

function specBlock(spec: SpecInput): string {
  return `### INPUT SPECIFICATION
Source: ${spec.source}
Key: ${spec.key}
Summary: ${spec.summary}
Priority: ${spec.priority}

Description / requirement text:
${spec.description}`
}

const buildTestCasesPrompt = (spec: SpecInput, count: number, focusInstructions?: string) => `${QA_ARCHITECT_ROLE}

${specBlock(spec)}
${focusBlock(focusInstructions)}
### TASK
Generate approximately ${count} distinct test cases with full coverage of the specification above. Spread them across scenarioType values: happy_path, negative, edge_case, boundary, ui_ux, security, performance.

### OUTPUT SCHEMA (exact)
${TEST_CASE_SCHEMA_BLOCK}

### COMPLIANCE
${GRANULARITY_RULE}
- 'id' must be sequential: TC-001, TC-002, …
- 'priority' is one of Critical, High, Medium, Low.
- 'scenarioType' is one of happy_path, negative, edge_case, boundary, ui_ux, security, performance.

${JSON_ONLY}`

// The chunked pipeline's workhorse: asks for a SMALL batch of new, non-
// duplicate cases per call, so no single call is asked for more detailed
// content than a smaller/faster model's output budget can actually hold —
// the root cause of the "truncated mid-array → invalid JSON" failure mode.
const buildTestCaseBatchPrompt = (
  spec: SpecInput,
  batchSize: number,
  startIdIndex: number,
  existingSummaries: string[],
  focusInstructions?: string
) => `${QA_ARCHITECT_ROLE}

${specBlock(spec)}
${focusBlock(focusInstructions)}
${existingSummaries.length > 0
    ? `### ALREADY GENERATED IN EARLIER BATCHES — DO NOT REPEAT OR REPHRASE THESE\n${existingSummaries.join('\n')}\n`
    : ''}
### TASK
Generate exactly ${batchSize} distinct, NEW test cases with full coverage of the specification above. Start ids at TC-${String(startIdIndex).padStart(3, '0')} and continue sequentially. Spread scenarioType across happy_path, negative, edge_case, boundary, ui_ux, security, performance — prioritise whichever of those aren't already well covered by the batches above.

### OUTPUT SCHEMA (exact)
${TEST_CASE_SCHEMA_BLOCK}

### COMPLIANCE
${GRANULARITY_RULE}
- 'priority' is one of Critical, High, Medium, Low.
- 'scenarioType' is one of happy_path, negative, edge_case, boundary, ui_ux, security, performance.

${JSON_ONLY}`

const buildMoreTestCasesPrompt = (spec: SpecInput, existing: TestCase[], startIdIndex: number) => {
  const existingList = existing.map(tc => `${tc.id} [${tc.scenarioType}]: ${tc.summary}`).join('\n')
  return `${QA_ARCHITECT_ROLE}

${specBlock(spec)}

### ALREADY GENERATED — DO NOT REPEAT OR REPHRASE THESE
${existingList}

### TASK
Generate ONLY genuinely new test cases that cover scenarios missing from the list above. Prioritise under-represented scenarioType values. Start ids at TC-${String(startIdIndex).padStart(3, '0')} and continue sequentially.

If — and only if — the existing suite already provides complete coverage and you cannot add a genuinely distinct case, respond with exactly this JSON object and nothing else:
{"noMoreCases": true}

### OUTPUT SCHEMA (exact)
${TEST_CASE_SCHEMA_BLOCK}

### COMPLIANCE
${GRANULARITY_RULE}

${JSON_ONLY}`
}

const buildExtractTestCasesPrompt = (text: string) => `${QA_ARCHITECT_ROLE}

### INPUT DATA
The following is raw text from an uploaded test document. Extract every test case it describes.

${text}

### EXTRACTION RULES
1. Capture ALL steps for each test case, preserving their sequence.
2. If step numbers are not explicit, number them from 1.
3. Infer scenarioType from the case's goal.
4. Infer priority from severity.
5. Extract as many test cases as the document clearly describes.

### OUTPUT SCHEMA (exact)
${TEST_CASE_SCHEMA_BLOCK}

${JSON_ONLY}`

const buildConfidencePrompt = (spec: SpecInput, testCases: TestCase[]) => {
  const caseBlock = testCases
    .map(tc => `${tc.id} [${tc.scenarioType}] ${tc.summary} — ${tc.steps.length} steps; first step: ${tc.steps[0]?.action || 'n/a'}`)
    .join('\n')

  return `You are a QA review lead auditing a generated test suite against its source specification. You did not write these cases; be sceptical.

### SOURCE SPECIFICATION
${spec.summary}
${spec.description.slice(0, 6000)}

### TEST CASES UNDER REVIEW
${caseBlock}

### TASK
Score every test case 0–100 on how well it is grounded in and traceable to the specification above.
- 80–100 ("high"): directly traceable to explicit requirement text, steps are concrete and executable.
- 50–79 ("medium"): reasonable inference from the spec, but relies on assumptions.
- 0–49 ("low"): speculative, generic boilerplate, or not supported by the spec at all.

Return ONE entry per test case. 'reason' must be at most 12 words and must name the specific weakness or strength.

### OUTPUT SCHEMA (exact)
[{ "testCaseId": "TC-001", "score": 88, "verdict": "high", "reason": "maps to stated login acceptance criteria" }]

Output ONLY the raw JSON array.`
}

// ─── Service ─────────────────────────────────────────────────────────────────

class AIService {
  async fetchModels(provider: AIProvider, apiKey: string): Promise<AIModel[]> {
    try {
      const response = await axios.post(`${API_BASE}/${provider}/models`, { apiKey })
      return response.data.models || []
    } catch {
      return this.getDefaultModels(provider)
    }
  }

  getDefaultModels(provider: AIProvider): AIModel[] {
    switch (provider) {
      case 'groq': return GROQ_DEFAULT_MODELS
      case 'openrouter': return OPENROUTER_DEFAULT_MODELS
      case 'gemini': return GEMINI_DEFAULT_MODELS
      case 'openai': return OPENAI_DEFAULT_MODELS
      default: return []
    }
  }

  async testConnection(
    provider: AIProvider,
    apiKey: string
  ): Promise<{ success: boolean; message: string; models?: AIModel[] }> {
    try {
      const response = await axios.post(`${API_BASE}/${provider}/models`, { apiKey }, { timeout: 15000 })
      const models: AIModel[] = response.data.models || []
      return {
        success: true,
        message: `Connected — ${models.length > 0 ? `${models.length} models available` : 'connection verified'}`,
        models
      }
    } catch (error: any) {
      if (error.message?.includes('Network Error') || error.code === 'ECONNREFUSED') {
        return {
          success: false,
          message: `Cannot reach the API proxy at ${API_BASE}. Start it with "npm run dev:full", or set VITE_API_URL if it is on another port.`
        }
      }
      if (error.response?.status === 401) {
        return { success: false, message: `Invalid API key for ${provider}` }
      }
      return { success: false, message: extractErrorMessage(error, 'Connection failed') }
    }
  }

  private async callAI(
    provider: AIProvider,
    apiKey: string,
    model: string,
    prompt: string,
    timeoutMs = 300000,
    mediaFiles?: MediaFileData[],
    opts?: GenOptions
  ): Promise<string> {
    if (!apiKey) throw new Error(`Add your ${provider} API key in Settings before generating.`)
    if (!model) throw new Error('Select a model in Settings before generating.')
    if (opts?.signal?.aborted) throw new GenerationAbortedError()

    const signal = opts?.signal
    const buildPayload = (content: any) => ({
      apiKey,
      model,
      messages: [{ role: 'user', content }],
      ...buildGenParams(opts)
    })

    let contentPayload: any = prompt
    if (mediaFiles && mediaFiles.length > 0) {
      contentPayload =
        provider === 'gemini'
          ? [
              { type: 'text', text: prompt },
              ...mediaFiles.map(f => ({ type: 'inline_data', mimeType: f.mimeType, data: f.base64 }))
            ]
          : [
              { type: 'text', text: prompt },
              ...mediaFiles.map(f => ({
                type: 'image_url',
                image_url: { url: `data:${f.mimeType};base64,${f.base64}` }
              }))
            ]
    }

    try {
      const payload = buildPayload(contentPayload)

      // One automatic retry on provider rate limits – multi-pass flows fire
      // several calls in quick succession and transient 429s shouldn't fail a run.
      let response
      try {
        response = await axios.post(`${API_BASE}/${provider}/complete`, payload, { timeout: timeoutMs, signal })
      } catch (rateLimitErr: any) {
        if (axios.isCancel(rateLimitErr)) throw new GenerationAbortedError()
        if (rateLimitErr.response?.status !== 429) throw rateLimitErr
        const retryAfter = Number(rateLimitErr.response.headers?.['retry-after'])
        const waitMs = Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15) * 1000, 30_000)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, waitMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new GenerationAbortedError())
          })
        })
        response = await axios.post(`${API_BASE}/${provider}/complete`, payload, { timeout: timeoutMs, signal })
      }

      const content = response.data.content
      if (!content) {
        throw new Error(
          `${provider} returned an empty response — the model may have hit its output limit or refused the request. Try again or switch models.`
        )
      }
      return content
    } catch (error: any) {
      if (axios.isCancel(error) || error instanceof GenerationAbortedError) throw new GenerationAbortedError()
      const errMsg = extractErrorMessage(error, 'AI generation failed')

      // Some models/providers reject multimodal content arrays – fall back to
      // a text-only prompt rather than losing the whole run.
      const rejectedMultimodal = /must be a string|content must be/i.test(errMsg)
      if (mediaFiles && mediaFiles.length > 0 && rejectedMultimodal) {
        const retry = await axios.post(`${API_BASE}/${provider}/complete`, buildPayload(prompt), {
          timeout: timeoutMs,
          signal
        })
        if (!retry.data.content) {
          throw new Error(`${provider} returned an empty response on the text-only retry.`)
        }
        return retry.data.content
      }

      if (error.response?.status === 401) throw new Error(`Authentication failed for ${provider}. Check your API key.`)
      if (error.response?.status === 429) throw new Error(`Rate limited by ${provider}. Try again in a moment.`)
      throw new Error(errMsg)
    }
  }

  /** Public low-level completion, for callers that own their own prompt. */
  async complete(
    provider: AIProvider,
    apiKey: string,
    model: string,
    prompt: string,
    opts?: GenOptions,
    mediaFiles?: MediaFileData[],
    timeoutMs = 300000
  ): Promise<string> {
    return this.callAI(provider, apiKey, model, prompt, timeoutMs, mediaFiles, opts)
  }

  // One-shot repair round-trip: sends the actual validation error back to the
  // model so the retry is informed, not a blind re-roll.
  makeRepairFn(provider: AIProvider, apiKey: string, model: string): RepairFn {
    return async (errorMessage: string, badOutput: string) => {
      const repairPrompt =
        `Your previous response failed JSON validation.\n` +
        `Validation error: ${errorMessage}\n\n` +
        `Your previous response (may be truncated):\n${badOutput}\n\n` +
        `Return ONLY the corrected, complete, valid JSON. No commentary, no markdown fences.`
      return this.callAI(provider, apiKey, model, repairPrompt, 120000, undefined, {
        json: true,
        temperature: 0
      })
    }
  }

  private parseTestCases(raw: string, repair?: RepairFn): Promise<TestCase[]> {
    return parseWithRepair(raw, TestCasesPayloadSchema, repair) as Promise<TestCase[]>
  }

  async generateTestCases(
    provider: AIProvider,
    apiKey: string,
    model: string,
    spec: SpecInput,
    mediaFiles?: MediaFileData[],
    count = 12,
    signal?: AbortSignal
  ): Promise<TestCase[]> {
    const raw = await this.callAI(provider, apiKey, model, buildTestCasesPrompt(spec, count), 300000, mediaFiles, {
      json: true,
      temperature: 0.4,
      maxTokens: 8000,
      signal
    })
    return this.parseTestCases(raw, this.makeRepairFn(provider, apiKey, model))
  }

  async generateMoreTestCases(
    provider: AIProvider,
    apiKey: string,
    model: string,
    spec: SpecInput,
    existingCases: TestCase[],
    signal?: AbortSignal
  ): Promise<MoreTestCasesResponse> {
    const maxNum = existingCases.reduce((max, tc) => {
      const match = tc.id.match(/TC-(\d+)/)
      return match ? Math.max(max, parseInt(match[1], 10)) : max
    }, 0)

    const raw = await this.callAI(
      provider,
      apiKey,
      model,
      buildMoreTestCasesPrompt(spec, existingCases, maxNum + 1),
      300000,
      undefined,
      { json: true, temperature: 0.5, maxTokens: 8000, signal }
    )

    // Sentinel check: parse first, then inspect the flag – substring matching
    // false-positives when "noMoreCases" appears inside test content.
    try {
      const probe: any = extractJson(raw)
      if (probe && !Array.isArray(probe) && probe.noMoreCases === true) {
        return { testCases: [], noMoreCases: true }
      }
    } catch {
      /* not parseable yet – let parseTestCases run its repair pass */
    }

    try {
      const parsed = await this.parseTestCases(raw, this.makeRepairFn(provider, apiKey, model))
      return { testCases: parsed, noMoreCases: false }
    } catch (err) {
      if (/no more|fully covered/i.test(raw)) return { testCases: [], noMoreCases: true }
      throw err
    }
  }

  async extractTestCasesFromText(
    provider: AIProvider,
    apiKey: string,
    model: string,
    text: string,
    signal?: AbortSignal
  ): Promise<TestCase[]> {
    const raw = await this.callAI(provider, apiKey, model, buildExtractTestCasesPrompt(text), 300000, undefined, {
      json: true,
      temperature: 0.2,
      maxTokens: 8000,
      signal
    })
    return this.parseTestCases(raw, this.makeRepairFn(provider, apiKey, model))
  }

  /** Second-pass LLM judge: scores how well each case is grounded in the spec. */
  async assessConfidence(
    provider: AIProvider,
    apiKey: string,
    model: string,
    spec: SpecInput,
    testCases: TestCase[],
    signal?: AbortSignal
  ): Promise<ConfidenceAssessment[]> {
    const raw = await this.callAI(
      provider,
      apiKey,
      model,
      buildConfidencePrompt(spec, testCases),
      180000,
      undefined,
      { json: true, temperature: 0, maxTokens: 4000, signal }
    )
    return parseWithRepair(raw, ConfidenceReportSchema, this.makeRepairFn(provider, apiKey, model))
  }

  /**
   * Generates ONE batch of new, non-duplicate test cases — the building block
   * the resilient chunked pipeline (fastGenerationPipeline.ts) calls
   * repeatedly. Kept small and focused instead of asking for the whole suite
   * in one call: a single call for e.g. 12 detailed 8-30-step cases is exactly
   * what pushes weaker/faster models past their output budget mid-array,
   * producing truncated, unparseable JSON.
   */
  async generateTestCaseBatch(
    provider: AIProvider,
    apiKey: string,
    model: string,
    spec: SpecInput,
    batchSize: number,
    startIdIndex: number,
    existingSummaries: string[],
    focusInstructions?: string,
    mediaFiles?: MediaFileData[],
    signal?: AbortSignal
  ): Promise<TestCase[]> {
    const raw = await this.callAI(
      provider,
      apiKey,
      model,
      buildTestCaseBatchPrompt(spec, batchSize, startIdIndex, existingSummaries, focusInstructions),
      300000,
      mediaFiles,
      { json: true, temperature: 0.4, maxTokens: 8000, signal }
    )
    return this.parseTestCases(raw, this.makeRepairFn(provider, apiKey, model))
  }
}

export default new AIService()
