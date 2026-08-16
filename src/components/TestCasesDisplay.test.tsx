import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TestCasesDisplay from './TestCasesDisplay'
import type { TestCase } from '../services/aiService'

const testCase = (overrides: Partial<TestCase> = {}): TestCase => ({
  id: 'TC-001',
  summary: 'User signs in with valid credentials',
  issueType: 'Test',
  priority: 'High',
  labels: 'functional',
  testType: 'Functional',
  precondition: 'A registered account exists',
  steps: [
    { stepNumber: 1, action: 'Open the login page', testData: '/login', expectedResult: 'Form is shown' },
    { stepNumber: 2, action: 'Submit valid credentials', testData: 'user@example.com', expectedResult: 'Dashboard loads' }
  ],
  status: 'Not Executed',
  component: 'Auth',
  estimatedTime: '10m',
  scenarioType: 'happy_path',
  ...overrides
})

/**
 * The component is controlled, so the harness owns the state and applies every
 * change — exercising the same round-trip the real app does, rather than
 * asserting against a spy that never feeds the new value back.
 */
function Harness({
  initial,
  onChange,
  onAutomate
}: {
  initial: TestCase[]
  onChange: (next: TestCase[]) => void
  onAutomate: (cases: TestCase[]) => void
}) {
  const [cases, setCases] = useState(initial)
  return (
    <TestCasesDisplay
      testCases={cases}
      allCases={cases}
      specId="spec"
      busy={false}
      automating={false}
      onGenerateMore={vi.fn()}
      onAutomate={onAutomate}
      onChange={next => {
        setCases(next)
        onChange(next)
      }}
    />
  )
}

function setup(cases: TestCase[] = [testCase()]) {
  const onChange = vi.fn()
  const onAutomate = vi.fn()
  render(<Harness initial={cases} onChange={onChange} onAutomate={onAutomate} />)
  return { onChange, onAutomate, user: userEvent.setup() }
}

const lastCases = (onChange: ReturnType<typeof vi.fn>): TestCase[] => onChange.mock.calls.at(-1)![0]

describe('TestCasesDisplay editing', () => {
  it('edits a summary and reports the change upward', async () => {
    const { onChange, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Edit TC-001' }))
    const summary = screen.getByLabelText('Summary for TC-001')
    await user.clear(summary)
    await user.type(summary, 'Renamed case')

    expect(lastCases(onChange)[0].summary).toBe('Renamed case')
  })

  it('deletes a step and renumbers the rest', async () => {
    const { onChange, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Edit TC-001' }))
    await user.click(screen.getByRole('button', { name: 'Delete step 1' }))

    const updated = lastCases(onChange)[0]
    expect(updated.steps).toHaveLength(1)
    expect(updated.steps[0].action).toBe('Submit valid credentials')
    // Renumbering matters: exports and the automation stage key off stepNumber.
    expect(updated.steps[0].stepNumber).toBe(1)
  })

  it('appends a new step with the next number', async () => {
    const { onChange, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Edit TC-001' }))
    await user.click(screen.getByRole('button', { name: /Add step/ }))

    const updated = lastCases(onChange)[0]
    expect(updated.steps).toHaveLength(3)
    expect(updated.steps[2].stepNumber).toBe(3)
  })

  it('deletes a whole test case', async () => {
    const { onChange, user } = setup([testCase(), testCase({ id: 'TC-002', summary: 'Second case' })])

    await user.click(screen.getByRole('button', { name: 'Delete TC-001' }))

    expect(lastCases(onChange).map(tc => tc.id)).toEqual(['TC-002'])
  })
})

describe('TestCasesDisplay traceability', () => {
  it('shows the cited requirement and its source quote', () => {
    setup([
      testCase({
        sourceRequirement: { requirementId: 'REQ-3', snippet: 'the system must reject invalid credentials' }
      })
    ])

    // A lone case renders expanded, so the citation and its quote are both visible.
    expect(screen.getByTitle(/the system must reject invalid credentials/)).toHaveTextContent('REQ-3')
    expect(screen.getByText(/REQ-3: “the system must reject invalid credentials”/)).toBeInTheDocument()
  })

  it('surfaces the grounding score when the judge pass has run', () => {
    setup([testCase({ confidence: { testCaseId: 'TC-001', score: 91, verdict: 'high', reason: 'maps to stated criteria' } })])
    expect(screen.getByTitle('maps to stated criteria')).toHaveTextContent('91% grounded')
  })
})

describe('TestCasesDisplay filtering', () => {
  it('filters by scenario type', async () => {
    const { user } = setup([
      testCase(),
      testCase({ id: 'TC-002', summary: 'Rejects a bad password', scenarioType: 'negative' })
    ])

    await user.click(screen.getByRole('button', { name: /^Negative \(1\)$/ }))
    expect(screen.queryByText('User signs in with valid credentials')).not.toBeInTheDocument()
    expect(screen.getByText('Rejects a bad password')).toBeInTheDocument()
  })

  it('reports average grounding across scored cases', () => {
    setup([
      testCase({ confidence: { testCaseId: 'TC-001', score: 90, verdict: 'high', reason: '' } }),
      testCase({ id: 'TC-002', confidence: { testCaseId: 'TC-002', score: 70, verdict: 'medium', reason: '' } })
    ])
    const stat = screen.getByText('Avg. grounding').parentElement!
    expect(within(stat).getByText('80%')).toBeInTheDocument()
  })
})

describe('TestCasesDisplay selection', () => {
  const three = () => [
    testCase(),
    testCase({ id: 'TC-002', summary: 'Rejects a bad password', scenarioType: 'negative' }),
    testCase({ id: 'TC-003', summary: 'Locks after five attempts', scenarioType: 'security' })
  ]

  it('shows no bulk bar until something is selected', () => {
    setup(three())
    expect(screen.queryByRole('button', { name: /^Automate/ })).not.toBeInTheDocument()
  })

  it('automates only the selected cases', async () => {
    const { onAutomate, user } = setup(three())

    await user.click(screen.getByLabelText('Select TC-001'))
    await user.click(screen.getByLabelText('Select TC-003'))
    await user.click(screen.getByRole('button', { name: /^Automate 2$/ }))

    expect(onAutomate).toHaveBeenCalledTimes(1)
    expect(onAutomate.mock.calls[0][0].map((c: TestCase) => c.id)).toEqual(['TC-001', 'TC-003'])
  })

  it('deletes only the selected cases and clears the bar', async () => {
    const { onChange, user } = setup(three())

    await user.click(screen.getByLabelText('Select TC-002'))
    await user.click(screen.getByRole('button', { name: /^Delete 1$/ }))

    expect(lastCases(onChange).map(c => c.id)).toEqual(['TC-001', 'TC-003'])
    expect(screen.queryByRole('button', { name: /^Delete 1$/ })).not.toBeInTheDocument()
  })

  it('select-all covers the filtered view only, never hidden cases', async () => {
    const { onAutomate, user } = setup(three())

    await user.click(screen.getByRole('button', { name: /^Negative \(1\)$/ }))
    await user.click(screen.getByLabelText('Select all cases in this view'))
    await user.click(screen.getByRole('button', { name: /^Automate 1$/ }))

    expect(onAutomate.mock.calls[0][0].map((c: TestCase) => c.id)).toEqual(['TC-002'])
  })

  it('drops a case from the selection when it is deleted individually', async () => {
    const { user } = setup(three())

    await user.click(screen.getByLabelText('Select TC-001'))
    await user.click(screen.getByLabelText('Select TC-002'))
    expect(screen.getByRole('button', { name: /^Automate 2$/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete TC-001' }))
    expect(screen.getByRole('button', { name: /^Automate 1$/ })).toBeInTheDocument()
  })

  it('scopes the export dropdown to the selection', async () => {
    const { user } = setup(three())

    await user.click(screen.getByLabelText('Select TC-001'))
    const bulkExport = screen.getAllByRole('button', { name: /^Export/ }).at(-1)!
    await user.click(bulkExport)

    expect(screen.getByText('Exports the 1 selected case')).toBeInTheDocument()
  })
})
