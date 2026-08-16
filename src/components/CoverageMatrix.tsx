import type { CoverageCell, Requirement, ScenarioType } from '../services/schemas'
import { SCENARIO_TYPES } from '../services/schemas'

// Requirements down, scenario types across. The point of the grid is the gaps:
// cells the planner said were needed but generation never filled.

const SCENARIO_LABEL: Record<ScenarioType, string> = {
  happy_path: 'Happy',
  negative: 'Negative',
  edge_case: 'Edge',
  boundary: 'Boundary',
  ui_ux: 'UI/UX',
  security: 'Security',
  performance: 'Perf'
}

const STATUS_TITLE: Record<CoverageCell['status'], string> = {
  covered: 'Covered',
  partial: 'Partially covered — fewer cases than planned',
  gap: 'GAP — planned but no test case was generated',
  not_applicable: 'Not applicable to this requirement'
}

const STATUS_STYLE: Record<CoverageCell['status'], { background: string; color: string }> = {
  covered: { background: 'var(--mint-dim)', color: 'var(--mint)' },
  partial: { background: 'var(--warn-dim)', color: 'var(--warn)' },
  gap: { background: 'var(--err-dim)', color: 'var(--err)' },
  not_applicable: { background: 'transparent', color: 'var(--text-faint)' }
}

export default function CoverageMatrix({
  requirements,
  coverage,
  onCellClick
}: {
  requirements: Requirement[]
  coverage: CoverageCell[]
  onCellClick?: (requirementId: string, scenarioType: ScenarioType) => void
}) {
  const cellByKey = new Map(coverage.map(c => [`${c.requirementId}|${c.scenarioType}`, c]))
  const gaps = coverage.filter(c => c.status === 'gap').length
  const covered = coverage.filter(c => c.status === 'covered' || c.status === 'partial').length

  if (requirements.length === 0) return null

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
        <span className="chip chip-mint">{covered} covered</span>
        <span className={`chip ${gaps > 0 ? 'chip-err' : ''}`}>{gaps} gaps</span>
        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Click a filled cell to filter the test cases. Gaps are scenarios the planner expected but generation did not produce.
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="eyebrow sticky left-0 px-3 py-2 text-left" style={{ background: 'var(--bg-surface)', minWidth: 260 }}>
                Requirement
              </th>
              {SCENARIO_TYPES.map(st => (
                <th key={st} className="eyebrow px-1 py-2 text-center" style={{ width: 78 }}>
                  {SCENARIO_LABEL[st]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requirements.map(req => (
              <tr key={req.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="sticky left-0 px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
                  <span className="mono mr-1.5 text-[11px]" style={{ color: 'var(--accent-hi)' }}>
                    {req.id}
                  </span>
                  {req.grounded === false && (
                    <span className="chip chip-warn mr-1.5" title="Source snippet not verified verbatim against the input">
                      unverified
                    </span>
                  )}
                  <span title={`Source: "${req.sourceSnippet}"`} style={{ color: 'var(--text-dim)' }}>
                    {req.text}
                  </span>
                </td>
                {SCENARIO_TYPES.map(st => {
                  const cell = cellByKey.get(`${req.id}|${st}`)
                  const status = cell?.status ?? 'not_applicable'
                  const count = cell?.testCaseIds.length ?? 0
                  const clickable = count > 0 && Boolean(onCellClick)
                  return (
                    <td key={st} className="px-1 py-1 text-center">
                      <button
                        className="mono w-full rounded py-1 text-[11px] font-semibold"
                        style={{ ...STATUS_STYLE[status], cursor: clickable ? 'pointer' : 'default' }}
                        title={`${req.id} × ${SCENARIO_LABEL[st]}: ${STATUS_TITLE[status]}${count > 0 ? ` (${cell!.testCaseIds.join(', ')})` : ''}`}
                        onClick={() => clickable && onCellClick!(req.id, st)}
                        disabled={!clickable}
                      >
                        {status === 'not_applicable' ? '–' : status === 'gap' ? '✕' : count}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
