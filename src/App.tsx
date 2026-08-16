import { useCallback, useMemo, useRef, useState } from 'react'
import { AI_PROVIDERS, SettingsProvider, keyFieldFor, useSettings, type AIProvider } from './context/SettingsContext'
import { useTheme } from './hooks/useTheme'
import aiService, { GenerationAbortedError, type SpecInput as Spec, type TestCase } from './services/aiService'
import {
  buildAutomationSuite,
  type AutomationBuildResult,
  type AutomationContext
} from './services/automationBuilder'
import {
  PipelineStallError,
  analyzeRequirementTestability,
  extractRequirementsStage,
  finalizeCoverage,
  generateFromRequirements,
  resumeGeneration,
  type GenerationCheckpoint,
  type GroundedConfig
} from './services/groundedPipeline'
import {
  FastGenerationStallError,
  generateTestCasesResilient,
  resumeFastGeneration,
  type FastGenerationCheckpoint
} from './services/fastGenerationPipeline'
import type { CoverageCell, Requirement, RequirementAnalysis, ScenarioType } from './services/schemas'
import { sanitizeName } from './services/exportService'
import { extractErrorMessage } from './services/errorUtils'
import type { FrameworkProfile } from './services/frameworkAnalyzer'
import Header from './components/Header'
import SettingsPanel from './components/SettingsPanel'
import SpecInput, { type AttachedMedia } from './components/SpecInput'
import FrameworkUploader from './components/FrameworkUploader'
import GroundingPanel from './components/GroundingPanel'
import StepSection from './components/StepSection'
import TestCasesDisplay from './components/TestCasesDisplay'
import AutomationPanel from './components/AutomationPanel'
import RequirementsReview, { type GenerationChoices } from './components/RequirementsReview'
import CoverageMatrix from './components/CoverageMatrix'
import StalledGenerationPanel, { type ProviderOption } from './components/StalledGenerationPanel'
import GenerationProgress, { type ProgressEntry } from './components/GenerationProgress'
import ErrorToast from './components/ErrorToast'
import { IconCheck, IconSpark } from './components/Icons'

type Tab = 'cases' | 'coverage' | 'automation'
type Phase = 'input' | 'review' | 'results'
type Busy = null | 'extract' | 'cases' | 'more' | 'automation' | 'resume'

// Either pipeline can stall; the panel and resume logic only need to know
// which kind of checkpoint they're holding.
type StallInfo =
  | { kind: 'deep'; checkpoint: GenerationCheckpoint }
  | { kind: 'fast'; checkpoint: FastGenerationCheckpoint }

interface StallState {
  info: StallInfo
  message: string
  tried: string[]
}

const BUSY_LABEL: Record<string, string> = {
  extract: 'Extracting requirements…',
  cases: 'Generating test cases…',
  resume: 'Resuming generation…',
  automation: 'Generating automation suite…'
}

function Workspace() {
  const { settings, updatePreferences, activeApiKey, activeModel } = useSettings()
  const { theme, toggleTheme } = useTheme()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [media, setMedia] = useState<AttachedMedia[]>([])
  const [framework, setFramework] = useState<FrameworkProfile | null>(null)
  const [grounding, setGrounding] = useState<AutomationContext>({})
  const [openStep, setOpenStep] = useState<number | null>(1)
  const [focusInstructions, setFocusInstructions] = useState('')

  const [phase, setPhase] = useState<Phase>('input')
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [requirementWarnings, setRequirementWarnings] = useState<string[]>([])
  const [analyses, setAnalyses] = useState<RequirementAnalysis[] | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  const [testCases, setTestCases] = useState<TestCase[]>([])
  const [coverage, setCoverage] = useState<CoverageCell[]>([])
  const [pipelineWarnings, setPipelineWarnings] = useState<string[]>([])
  const [suite, setSuite] = useState<AutomationBuildResult | null>(null)
  /** Case ids the current suite was built from; null means "the whole set". */
  const [automationScopeIds, setAutomationScopeIds] = useState<string[] | null>(null)
  const [stall, setStall] = useState<StallState | null>(null)
  const [caseFilter, setCaseFilter] = useState<{ requirementId: string; scenarioType: ScenarioType } | null>(null)

  const [tab, setTab] = useState<Tab>('cases')
  const [busy, setBusy] = useState<Busy>(null)
  const [progressLog, setProgressLog] = useState<ProgressEntry[]>([])
  const [error, setError] = useState('')
  const [stoppedNotice, setStoppedNotice] = useState('')

  const abortRef = useRef<AbortController | null>(null)
  const progressIdRef = useRef(0)

  const { provider } = settings.ai
  const { deepMode, confidenceScoring, autoFailover, testCaseCount } = settings.preferences
  const ready = Boolean(spec && activeApiKey && activeModel)

  const groundedCount =
    (grounding.elements?.length || 0) +
    (grounding.collections?.length || 0) +
    (grounding.recordedActions?.length || 0)

  /** Every provider that has a key configured, with the models we know about. */
  const providerOptions: ProviderOption[] = useMemo(
    () =>
      AI_PROVIDERS.filter(p => (settings.ai[p.keyField] as string)?.trim()).map(p => ({
        id: p.id,
        label: p.label,
        models: settings.ai.loadedModels[p.id] || aiService.getDefaultModels(p.id)
      })),
    [settings.ai]
  )

  const apiKeyFor = useCallback(
    (id: AIProvider) => (settings.ai[keyFieldFor(id)] as string)?.trim() || '',
    [settings.ai]
  )

  // Appends a new log line, or — if the previous line was the same stage
  // still running — updates it in place instead of spamming duplicates.
  const logProgress = useCallback((text: string, status: ProgressEntry['status'] = 'running') => {
    setProgressLog(prev => {
      const last = prev[prev.length - 1]
      if (last && last.status === 'running' && status === 'running') {
        return [...prev.slice(0, -1), { ...last, text }]
      }
      const next = [...prev]
      if (last && last.status === 'running') next[next.length - 1] = { ...last, status: 'done' }
      return [...next, { id: progressIdRef.current++, text, status }]
    })
  }, [])

  const buildConfig = useCallback(
    (overrides: Partial<GroundedConfig> = {}): GroundedConfig => ({
      provider,
      apiKey: activeApiKey,
      model: activeModel,
      input: spec ? `${spec.summary}\n\n${spec.description}` : '',
      mediaFiles: media.length > 0 ? media.map(m => ({ mimeType: m.mimeType, base64: m.base64 })) : undefined,
      // With attachments and almost no prose, snippet verification has nothing
      // to check against — tell the pipeline rather than letting it flag everything.
      isVisual: Boolean(media.length > 0 && (!spec || spec.description.trim().length < 200)),
      scopeInstructions: focusInstructions.trim() || undefined,
      signal: abortRef.current?.signal,
      onProgress: p => logProgress(`${p.pass}: ${p.detail || p.status}`, p.status === 'error' ? 'error' : 'running'),
      onPartialCases: cases => setTestCases(cases),
      ...overrides
    }),
    [provider, activeApiKey, activeModel, spec, media, focusInstructions, logProgress]
  )

  const runGuarded = async (phaseName: Exclude<Busy, null>, task: (signal: AbortSignal) => Promise<void>) => {
    if (!activeApiKey || !activeModel) {
      setError('Add an API key and pick a model in Settings first.')
      setSettingsOpen(true)
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(phaseName)
    setError('')
    setStoppedNotice('')
    if (phaseName !== 'resume') setProgressLog([])
    try {
      await task(controller.signal)
    } catch (err) {
      if (err instanceof GenerationAbortedError) {
        setStoppedNotice(
          testCases.length > 0
            ? `Stopped — ${testCases.length} test case(s) generated so far were kept.`
            : 'Stopped before anything was generated.'
        )
      } else {
        setError(extractErrorMessage(err, 'Generation failed.'))
      }
    } finally {
      setBusy(null)
      abortRef.current = null
    }
  }

  /** Aborts whatever is currently running. Wired to every Stop button. */
  const stopGeneration = () => abortRef.current?.abort()

  /** Runs the judge pass, but never lets a scoring failure lose the test cases. */
  const withConfidence = async (cases: TestCase[]): Promise<TestCase[]> => {
    if (!spec || !confidenceScoring || cases.length === 0) return cases
    try {
      logProgress('scoring how well each case is grounded in the spec')
      const assessments = await aiService.assessConfidence(
        provider,
        activeApiKey,
        activeModel,
        spec,
        cases,
        abortRef.current?.signal
      )
      const byId = new Map(assessments.map(a => [a.testCaseId.toUpperCase(), a]))
      return cases.map(tc => {
        const match = byId.get(tc.id.toUpperCase())
        return match ? { ...tc, confidence: match } : tc
      })
    } catch (err) {
      if (err instanceof GenerationAbortedError) throw err
      console.warn('Confidence scoring failed; keeping unscored test cases.', err)
      return cases
    }
  }

  const acceptResult = async (result: {
    testCases: TestCase[]
    coverage: CoverageCell[]
    warnings: string[]
    requirements?: Requirement[]
  }) => {
    const scored = await withConfidence(result.testCases)
    const reqs = result.requirements ?? requirements
    setTestCases(scored)
    setCoverage(reqs.length > 0 ? finalizeCoverage(result.coverage, reqs, scored) : result.coverage)
    setPipelineWarnings(result.warnings)
    setSuite(null)
    // A scope pointing at the previous generation's case ids means nothing here.
    setAutomationScopeIds(null)
    setStall(null)
    setPhase('results')
    setTab('cases')
  }

  // ─── Fast path: chunked, checkpointed generation (never one giant call) ────
  const generateFast = () =>
    runGuarded('cases', async signal => {
      if (!spec) return
      setRequirements([])
      try {
        const cases = await generateTestCasesResilient({
          provider,
          apiKey: activeApiKey,
          model: activeModel,
          spec,
          mediaFiles: media.length > 0 ? media.map(m => ({ mimeType: m.mimeType, base64: m.base64 })) : undefined,
          count: testCaseCount,
          focusInstructions: focusInstructions.trim() || undefined,
          signal,
          onProgress: p => logProgress(p.detail || p.status, p.status === 'error' ? 'error' : 'running'),
          onPartialCases: setTestCases
        })
        await acceptResult({ testCases: cases, coverage: [], warnings: [], requirements: [] })
      } catch (err) {
        if (err instanceof FastGenerationStallError) {
          setPhase('results')
          await attemptFastFailover(err.checkpoint, err.message)
          return
        }
        throw err
      }
    })

  // ─── Deep path: extract → human review → plan → generate → critique ────────
  const extractRequirements = () =>
    runGuarded('extract', async signal => {
      if (!spec) return
      logProgress('extracting requirements from the specification')
      const cfg = buildConfig({ signal })
      const extracted = await extractRequirementsStage(cfg)
      if (extracted.requirements.length === 0) {
        setError('No requirements could be extracted. Try the fast path, or supply a more detailed specification.')
        return
      }
      setRequirements(extracted.requirements)
      setRequirementWarnings(extracted.warnings)
      setAnalyses(null)
      setPhase('review')

      // Advisory only — it must never block the review step it feeds.
      setAnalyzing(true)
      analyzeRequirementTestability(cfg, extracted.requirements)
        .then(result => setAnalyses(result.analyses))
        .catch(err => {
          if (!(err instanceof GenerationAbortedError)) {
            console.warn('Testability analysis failed; review continues without it.', err)
          }
        })
        .finally(() => setAnalyzing(false))
    })

  /**
   * On a stall, transparently retry the remaining work on every other
   * configured provider before surfacing the recovery panel. A rate limit on one
   * provider should not cost the user their completed work or their attention.
   */
  const attemptFailover = async (checkpoint: GenerationCheckpoint, message: string): Promise<boolean> => {
    let currentCheckpoint = checkpoint
    let currentMessage = message
    const attempted: string[] = []

    if (autoFailover) {
      const alternatives = providerOptions
        .flatMap(p =>
          p.models[0] ? [{ provider: p.id, model: p.models[0].id, label: `${p.label} · ${p.models[0].name}` }] : []
        )
        .filter(alt => !(alt.provider === provider && alt.model === activeModel))

      for (const alt of alternatives) {
        logProgress(`stalled — retrying automatically on ${alt.label}`)
        attempted.push(alt.label)
        try {
          const result = await resumeGeneration(
            buildConfig({ provider: alt.provider, apiKey: apiKeyFor(alt.provider), model: alt.model }),
            currentCheckpoint
          )
          await acceptResult({
            ...result,
            warnings: [...result.warnings, `Completed on ${alt.label} after the selected model stalled.`]
          })
          return true
        } catch (err) {
          if (err instanceof GenerationAbortedError) throw err
          if (err instanceof PipelineStallError) {
            // Keep the further-along checkpoint so the next attempt resumes from it.
            currentCheckpoint = err.checkpoint
            currentMessage = err.message
            continue
          }
          currentMessage = extractErrorMessage(err, currentMessage)
          break
        }
      }
    }

    setStall({ info: { kind: 'deep', checkpoint: currentCheckpoint }, message: currentMessage, tried: attempted })
    setTestCases(currentCheckpoint.testCases)
    return false
  }

  /** Same idea as attemptFailover, for the chunked fast-mode pipeline. */
  const attemptFastFailover = async (checkpoint: FastGenerationCheckpoint, message: string): Promise<boolean> => {
    let currentCheckpoint = checkpoint
    let currentMessage = message
    const attempted: string[] = []

    if (autoFailover) {
      const alternatives = providerOptions
        .flatMap(p =>
          p.models[0] ? [{ provider: p.id, model: p.models[0].id, label: `${p.label} · ${p.models[0].name}` }] : []
        )
        .filter(alt => !(alt.provider === provider && alt.model === activeModel))

      for (const alt of alternatives) {
        logProgress(`stalled — retrying automatically on ${alt.label}`)
        attempted.push(alt.label)
        try {
          const cases = await resumeFastGeneration(
            {
              provider: alt.provider,
              apiKey: apiKeyFor(alt.provider),
              model: alt.model,
              signal: abortRef.current?.signal,
              onProgress: p => logProgress(p.detail || p.status, p.status === 'error' ? 'error' : 'running'),
              onPartialCases: setTestCases
            },
            currentCheckpoint
          )
          await acceptResult({
            testCases: cases,
            coverage: [],
            warnings: [`Completed on ${alt.label} after the selected model stalled.`],
            requirements: []
          })
          return true
        } catch (err) {
          if (err instanceof GenerationAbortedError) throw err
          if (err instanceof FastGenerationStallError) {
            currentCheckpoint = err.checkpoint
            currentMessage = err.message
            continue
          }
          currentMessage = extractErrorMessage(err, currentMessage)
          break
        }
      }
    }

    setStall({ info: { kind: 'fast', checkpoint: currentCheckpoint }, message: currentMessage, tried: attempted })
    setTestCases(currentCheckpoint.testCases)
    return false
  }

  const generateFromReviewed = (reviewed: Requirement[], choices: GenerationChoices) =>
    runGuarded('cases', async signal => {
      setRequirements(reviewed)
      try {
        const result = await generateFromRequirements(buildConfig({ signal }), reviewed, requirementWarnings, {
          focusInstructions: choices.focusInstructions || undefined,
          automationFriendly: choices.automationFriendly
        })
        await acceptResult({ ...result, requirements: reviewed })
      } catch (err) {
        if (err instanceof GenerationAbortedError) throw err
        if (err instanceof PipelineStallError) {
          setPhase('results')
          await attemptFailover(err.checkpoint, err.message)
          return
        }
        throw err
      }
    })

  const resumeFromStall = (nextProvider: AIProvider, nextModel: string) =>
    runGuarded('resume', async signal => {
      if (!stall) return
      try {
        if (stall.info.kind === 'deep') {
          const result = await resumeGeneration(
            buildConfig({ provider: nextProvider, apiKey: apiKeyFor(nextProvider), model: nextModel, signal }),
            stall.info.checkpoint
          )
          await acceptResult(result)
        } else {
          const cases = await resumeFastGeneration(
            {
              provider: nextProvider,
              apiKey: apiKeyFor(nextProvider),
              model: nextModel,
              signal,
              onProgress: p => logProgress(p.detail || p.status, p.status === 'error' ? 'error' : 'running'),
              onPartialCases: setTestCases
            },
            stall.info.checkpoint
          )
          await acceptResult({ testCases: cases, coverage: [], warnings: [], requirements: [] })
        }
      } catch (err) {
        if (err instanceof GenerationAbortedError) throw err
        if (err instanceof PipelineStallError) {
          setStall({ info: { kind: 'deep', checkpoint: err.checkpoint }, message: err.message, tried: stall.tried })
          setTestCases(err.checkpoint.testCases)
          return
        }
        if (err instanceof FastGenerationStallError) {
          setStall({ info: { kind: 'fast', checkpoint: err.checkpoint }, message: err.message, tried: stall.tried })
          setTestCases(err.checkpoint.testCases)
          return
        }
        throw err
      }
    })

  const generateMore = () =>
    runGuarded('more', async signal => {
      if (!spec) return
      logProgress('looking for coverage gaps')
      const result = await aiService.generateMoreTestCases(provider, activeApiKey, activeModel, spec, testCases, signal)
      if (result.noMoreCases || result.testCases.length === 0) {
        setError('The model reports the existing suite already covers this specification.')
        return
      }
      const merged = [...testCases, ...(await withConfidence(result.testCases))]
      setTestCases(merged)
      if (requirements.length > 0) setCoverage(prev => finalizeCoverage(prev, requirements, merged))
      setSuite(null)
    })

  /**
   * Scope is held as ids, not case objects, so a later edit or deletion can
   * never regenerate from a stale copy — and an emptied scope falls back to the
   * full set rather than generating nothing.
   */
  const runAutomation = (scopeIds: string[] | null) =>
    runGuarded('automation', async signal => {
      const scoped = scopeIds ? testCases.filter(tc => scopeIds.includes(tc.id)) : []
      const cases = scoped.length > 0 ? scoped : testCases
      if (!spec || cases.length === 0) return
      logProgress(framework ? 'writing specs against your page objects' : 'scaffolding the Page Object Model')
      const built = await buildAutomationSuite({
        provider,
        apiKey: activeApiKey,
        model: activeModel,
        projectName: sanitizeName(spec.key || 'qa-suite'),
        testCases: cases,
        context: grounding,
        framework,
        signal,
        onProgress: detail => logProgress(detail)
      })
      setAutomationScopeIds(scoped.length > 0 ? scopeIds : null)
      setSuite(built)
      setTab('automation')
    })

  /** From the cases tab — an explicit subset the user ticked. */
  const automateSelected = (cases: TestCase[]) => runAutomation(cases.map(tc => tc.id))
  /** Regenerate keeps whatever scope produced the current suite; "use all" drops it. */
  const regenerateAutomation = () => runAutomation(automationScopeIds)
  const automateAll = () => runAutomation(null)

  const applyCaseEdits = (next: TestCase[]) => {
    setTestCases(next)
    if (requirements.length > 0) setCoverage(prev => finalizeCoverage(prev, requirements, next))
    setSuite(null)
  }

  const specId = spec?.key || 'spec'
  const visibleCases = caseFilter
    ? testCases.filter(
        tc =>
          tc.sourceRequirement?.requirementId === caseFilter.requirementId &&
          tc.scenarioType === caseFilter.scenarioType
      )
    : testCases

  const isGenerating = busy === 'cases' || busy === 'extract' || busy === 'resume' || busy === 'automation'

  return (
    <div className="min-h-full">
      <Header theme={theme} onToggleTheme={toggleTheme} onOpenSettings={() => setSettingsOpen(true)} />

      <main className="mx-auto grid max-w-[1560px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr]">
        <aside className="space-y-3 lg:sticky lg:top-[76px] lg:self-start">
          <StepSection
            index={1}
            title="Specification"
            hint="What should be tested? A live URL, a requirements document, a Jira issue, or pasted text — plus any screens or recordings."
            status={
              spec
                ? `${spec.source} · ${spec.description.length.toLocaleString()} chars${media.length ? ` · ${media.length} attachment${media.length === 1 ? '' : 's'}` : ''}`
                : 'Nothing loaded yet'
            }
            done={Boolean(spec)}
            open={openStep === 1}
            onToggle={() => setOpenStep(openStep === 1 ? null : 1)}
          >
            <SpecInput
              spec={spec}
              onSpec={next => {
                setSpec(next)
                if (next) setOpenStep(2)
              }}
              media={media}
              onMedia={setMedia}
              disabled={busy !== null}
            />
          </StepSection>

          <StepSection
            index={2}
            title="Your test framework"
            hint="Upload your existing Playwright repo and the suite will reuse your page classes, fixtures and naming instead of inventing generic ones. Parsed entirely in your browser — nothing is uploaded."
            status={
              framework
                ? `${framework.projectName} · ${framework.pages.length} page objects · ${framework.fixtures.length} fixtures`
                : 'Generation will scaffold its own Page Object Model'
            }
            done={Boolean(framework)}
            optional
            open={openStep === 2}
            onToggle={() => setOpenStep(openStep === 2 ? null : 2)}
          >
            <FrameworkUploader
              profile={framework}
              onProfile={next => {
                setFramework(next)
                if (next) setOpenStep(3)
              }}
              disabled={busy !== null}
            />
          </StepSection>

          <StepSection
            index={3}
            title="Selector grounding"
            hint="Show the app's real DOM and every generated locator is drawn from it instead of guessed. Import a blast-ground file and each one has also been resolved in a live browser. Without either, selectors are inferred from the spec text and marked TODO-SELECTOR."
            status={
              groundedCount > 0
                ? `${groundedCount} ${grounding.verified ? 'live-verified' : 'grounded'} selector${groundedCount === 1 ? '' : 's'}${grounding.baseUrl ? ` · ${grounding.baseUrl}` : ''}`
                : 'Locators will be inferred from the spec text'
            }
            done={groundedCount > 0}
            optional
            open={openStep === 3}
            onToggle={() => setOpenStep(openStep === 3 ? null : 3)}
          >
            <GroundingPanel context={grounding} onContext={setGrounding} disabled={busy !== null} />
          </StepSection>

          <section className="panel p-3.5">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="step-index">4</span>
              <h2 className="text-[13px] font-semibold">Generate</h2>
            </div>

            <div className="segmented mb-2">
              <button aria-pressed={!deepMode} onClick={() => updatePreferences({ deepMode: false })} disabled={busy !== null}>
                Fast
              </button>
              <button aria-pressed={deepMode} onClick={() => updatePreferences({ deepMode: true })} disabled={busy !== null}>
                Deep analysis
              </button>
            </div>
            <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {deepMode
                ? 'Extracts requirements, pauses for your review, plans coverage per scenario type, generates, then critiques its own output. Every case cites a requirement.'
                : 'Generates in small batches so one rate limit never loses the whole run. Quicker than deep analysis; no traceability or coverage matrix.'}
            </p>

            <label className="mb-3 block">
              <span className="eyebrow">Focus / scope (optional)</span>
              <textarea
                className="field mt-1.5 text-[12px]"
                rows={2}
                placeholder="e.g. only the checkout flow, or only payment failure scenarios"
                value={focusInstructions}
                disabled={busy !== null}
                onChange={e => setFocusInstructions(e.target.value)}
              />
              <span className="mt-1 block text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                Leave blank to cover the whole specification.
              </span>
            </label>

            {isGenerating ? (
              <button className="btn w-full" style={{ borderColor: 'var(--err-line)', color: 'var(--err)' }} onClick={stopGeneration}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn-primary w-full"
                onClick={() => (deepMode ? extractRequirements() : generateFast())}
                disabled={!ready || busy !== null}
              >
                <IconSpark size={14} />
                {deepMode ? 'Extract requirements' : testCases.length ? 'Regenerate test cases' : 'Generate test cases'}
              </button>
            )}

            {!activeApiKey && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--warn)' }}>
                Add an API key in Settings to enable generation.
              </p>
            )}
            {activeApiKey && !spec && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                Load a specification in step 1 to enable generation.
              </p>
            )}

            <ReadinessSummary
              hasFramework={Boolean(framework)}
              groundedCount={groundedCount}
              verified={Boolean(grounding.verified)}
              onJump={setOpenStep}
            />
          </section>
        </aside>

        <section className="min-w-0 space-y-4">
          {isGenerating && <GenerationProgress label={BUSY_LABEL[busy || ''] || 'Working…'} entries={progressLog} onStop={stopGeneration} />}

          {stoppedNotice && !isGenerating && (
            <div
              className="rise flex items-center gap-2 rounded-lg border p-3 text-[12px]"
              style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              {stoppedNotice}
            </div>
          )}

          {stall && (
            <StalledGenerationPanel
              stage={stall.info.kind === 'deep' ? stall.info.checkpoint.stage : 'fast'}
              message={stall.message}
              completedCases={stall.info.checkpoint.testCases.length}
              currentProvider={provider}
              currentModel={activeModel}
              providerOptions={providerOptions}
              autoFailoverTried={stall.tried}
              busy={busy === 'resume'}
              onResume={resumeFromStall}
              onDiscard={() => {
                setStall(null)
                setPhase('input')
              }}
            />
          )}

          {phase === 'review' ? (
            <RequirementsReview
              requirements={requirements}
              warnings={requirementWarnings}
              analyses={analyses}
              analyzing={analyzing}
              busy={busy !== null}
              initialFocusInstructions={focusInstructions}
              onConfirm={generateFromReviewed}
              onCancel={() => setPhase(testCases.length > 0 ? 'results' : 'input')}
            />
          ) : testCases.length === 0 ? (
            !isGenerating && <EmptyState hasFramework={Boolean(framework)} groundedCount={groundedCount} deepMode={deepMode} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-5 border-b" style={{ borderColor: 'var(--border)' }}>
                <button className={`tab ${tab === 'cases' ? 'tab-active' : ''}`} onClick={() => setTab('cases')}>
                  Test cases <span className="mono ml-1 opacity-60">{testCases.length}</span>
                </button>
                {coverage.length > 0 && (
                  <button className={`tab ${tab === 'coverage' ? 'tab-active' : ''}`} onClick={() => setTab('coverage')}>
                    Traceability <span className="mono ml-1 opacity-60">{requirements.length}</span>
                  </button>
                )}
                <button className={`tab ${tab === 'automation' ? 'tab-active' : ''}`} onClick={() => setTab('automation')}>
                  Automation suite
                  {suite && <span className="mono ml-1 opacity-60">{suite.testFiles.length}</span>}
                </button>

                {requirements.length > 0 && (
                  <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setPhase('review')} disabled={busy !== null}>
                    Back to requirements
                  </button>
                )}
              </div>

              {pipelineWarnings.length > 0 && tab !== 'automation' && (
                <details
                  className="rounded-lg border p-3"
                  style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-dim)' }}
                >
                  <summary className="eyebrow cursor-pointer" style={{ color: 'var(--warn)' }}>
                    Pipeline notes ({pipelineWarnings.length})
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {pipelineWarnings.map((w, i) => (
                      <li key={`${w}-${i}`} className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                        {w}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {caseFilter && tab === 'cases' && (
                <div className="flex items-center gap-2">
                  <span className="chip chip-accent">
                    {caseFilter.requirementId} × {caseFilter.scenarioType.replace('_', ' ')}
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setCaseFilter(null)}>
                    Clear filter
                  </button>
                </div>
              )}

              {tab === 'cases' && (
                <TestCasesDisplay
                  testCases={visibleCases}
                  allCases={testCases}
                  specId={specId}
                  busy={busy === 'more'}
                  automating={busy === 'automation'}
                  onGenerateMore={generateMore}
                  onAutomate={automateSelected}
                  onChange={applyCaseEdits}
                />
              )}

              {tab === 'coverage' && (
                <CoverageMatrix
                  requirements={requirements}
                  coverage={coverage}
                  onCellClick={(requirementId, scenarioType) => {
                    setCaseFilter({ requirementId, scenarioType })
                    setTab('cases')
                  }}
                />
              )}

              {tab === 'automation' && !isGenerating && (
                // isGenerating already covers busy === 'automation', so
                // AutomationPanel is only ever mounted while it is false —
                // GenerationProgress (above) owns the busy/spinner UI instead.
                <AutomationPanel
                  suite={suite}
                  specId={specId}
                  busy={false}
                  hasFramework={Boolean(framework)}
                  hasGrounding={groundedCount > 0}
                  verified={Boolean(grounding.verified)}
                  scopeCount={automationScopeIds ? testCases.filter(tc => automationScopeIds.includes(tc.id)).length : null}
                  totalCount={testCases.length}
                  onGenerate={regenerateAutomation}
                  onGenerateAll={automateAll}
                />
              )}
            </>
          )}
        </section>
      </main>

      {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/**
 * Tells the user exactly what the current inputs will produce, before they
 * spend a generation. Each unmet condition links back to the step that fixes it.
 */
function ReadinessSummary({
  hasFramework,
  groundedCount,
  verified,
  onJump
}: {
  hasFramework: boolean
  groundedCount: number
  verified: boolean
  onJump: (step: number) => void
}) {
  const rows = [
    {
      ok: hasFramework,
      step: 2,
      yes: 'Specs will reuse your own page objects and conventions.',
      no: 'A fresh Page Object Model will be scaffolded — upload your framework to reuse yours instead.'
    },
    {
      ok: groundedCount > 0,
      step: 3,
      yes: verified
        ? `Locators will come from ${groundedCount} selector${groundedCount === 1 ? '' : 's'} resolved against a live browser.`
        : `Locators will come from ${groundedCount} grounded selector${groundedCount === 1 ? '' : 's'} — import a blast-ground file to have them live-verified.`,
      no: 'Locators will be inferred from the spec and marked TODO-SELECTOR — ground them to get a runnable suite.'
    }
  ]

  return (
    <ul className="mt-3 space-y-1.5 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      {rows.map(row => (
        <li key={row.step} className="flex items-start gap-1.5 text-[11px]">
          <span
            className="mt-1 shrink-0"
            style={{ width: 5, height: 5, borderRadius: 999, background: row.ok ? 'var(--mint)' : 'var(--warn)' }}
          />
          <span style={{ color: 'var(--text-dim)' }}>
            {row.ok ? row.yes : row.no}
            {!row.ok && (
              <button className="ml-1 underline" style={{ color: 'var(--accent-hi)' }} onClick={() => onJump(row.step)}>
                Step {row.step}
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({
  hasFramework,
  groundedCount,
  deepMode
}: {
  hasFramework: boolean
  groundedCount: number
  deepMode: boolean
}) {
  const steps = [
    {
      n: 1,
      title: 'Point it at a specification',
      body: 'A live URL, a document, a Jira issue, pasted text — or screenshots and screen recordings.'
    },
    {
      n: 2,
      title: 'Add your test framework',
      body: 'Your repo is parsed in-browser, so generation reuses your own page objects, fixtures and naming.'
    },
    {
      n: 3,
      title: 'Ground the selectors',
      body: 'Fetch the page, paste its DOM, or import a blast-ground file whose every selector was resolved in a live browser.'
    },
    {
      n: 4,
      title: 'Generate and export',
      body: deepMode
        ? 'Requirements are extracted for your review, coverage is planned per scenario type, then cases are generated and critiqued.'
        : 'Cases stream in as small batches, exportable to Jira, Zephyr, Xray or TestRail — then a Playwright suite as a runnable ZIP.'
    }
  ]

  return (
    <div className="panel px-6 py-12 sm:px-10">
      <div className="mx-auto max-w-lg text-center">
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent-line)', color: 'var(--accent-hi)' }}
        >
          <IconSpark size={20} />
        </div>
        <h2 className="text-[18px] font-semibold">From specification to a suite that actually runs</h2>
        <p className="mt-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
          Most generators invent a framework you have to rewrite and selectors that don't exist. This one reads your
          framework first, and grounds every locator in a real DOM.
        </p>
      </div>

      <ol className="mx-auto mt-8 grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(step => {
          const done = (step.n === 2 && hasFramework) || (step.n === 3 && groundedCount > 0)
          return (
            <li key={step.n} className="panel-raised p-3.5" style={done ? { borderColor: 'var(--mint-line)' } : undefined}>
              <span
                className="step-index"
                style={done ? { background: 'var(--mint-dim)', color: 'var(--mint)', borderColor: 'var(--mint-line)' } : undefined}
              >
                {done ? <IconCheck size={12} /> : step.n}
              </span>
              <p className="mt-2 text-[13px] font-medium">{step.title}</p>
              <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                {step.body}
              </p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <Workspace />
    </SettingsProvider>
  )
}
