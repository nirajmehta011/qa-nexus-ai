import JSZip from 'jszip'
import type { TestCase, PlaywrightAutomationData } from './aiService'
import { loadCdnScript } from './documentParser'

// Export targets are the formats a QA team actually imports into: Jira's CSV
// importer, Xray, Zephyr Scale, TestRail — plus the runnable Playwright ZIP.

const escapeCSV = (val: string): string => {
  if (!val) return ''
  const str = String(val).replace(/"/g, '""')
  return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const el = document.createElement('a')
  el.href = url
  el.download = filename
  document.body.appendChild(el)
  el.click()
  document.body.removeChild(el)
  URL.revokeObjectURL(url)
}

function downloadCSVFile(csvContent: string, filename: string) {
  // BOM keeps Excel from mangling UTF-8 on open.
  triggerDownload(new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' }), filename)
}

// Filenames and ZIP folder names must never contain path separators, colons or
// spaces – a URL project name (https://…) otherwise creates nested folders
// inside the ZIP, burying package.json. Keeps [A-Za-z0-9._-] only.
export function sanitizeName(raw: string): string {
  const cleaned = (raw || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return cleaned || 'qa-suite'
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ─── Jira CSV importer (one row per step, case fields on the first row) ──────
export function exportTestCasesAsCSV(testCases: TestCase[], specId: string, download = true): string {
  const headers = [
    'Summary', 'Issue Type', 'Priority', 'Labels', 'Test Type', 'Scenario Type',
    'Component', 'Estimated Time', 'Precondition', 'Step #', 'Step Action',
    'Step Data', 'Step Expected Result', 'Status'
  ]

  const rows: string[] = [headers.join(',')]

  for (const tc of testCases) {
    const steps = tc.steps?.length ? tc.steps : [{ stepNumber: 1, action: '', testData: '', expectedResult: '' }]
    steps.forEach((step, idx) => {
      const firstRowOnly = (val: string) => (idx === 0 ? escapeCSV(val) : '')
      rows.push([
        firstRowOnly(`${tc.id}: ${tc.summary}`),
        firstRowOnly(tc.issueType || 'Test'),
        firstRowOnly(tc.priority || 'Medium'),
        firstRowOnly(tc.labels || ''),
        firstRowOnly(tc.testType || 'Functional'),
        firstRowOnly(tc.scenarioType || ''),
        firstRowOnly(tc.component || ''),
        firstRowOnly(tc.estimatedTime || '15m'),
        firstRowOnly(tc.precondition || ''),
        escapeCSV(String(step.stepNumber || idx + 1)),
        escapeCSV(step.action || ''),
        escapeCSV(step.testData || ''),
        escapeCSV(step.expectedResult || ''),
        firstRowOnly(tc.status || 'Not Executed')
      ].join(','))
    })
  }

  const csv = rows.join('\n')
  if (download) downloadCSVFile(csv, `test-cases-${sanitizeName(specId)}-jira-import.csv`)
  return csv
}

// ─── Zephyr Scale importer (one row per step) ────────────────────────────────
export function exportTestCasesAsZephyrCSV(testCases: TestCase[], specId: string, download = true): string {
  const headers = ['Name', 'Priority', 'Status', 'Precondition', 'Labels', 'Component', 'Test Step', 'Test Data', 'Expected Result']
  const rows: string[] = [headers.join(',')]

  for (const tc of testCases) {
    const steps = tc.steps?.length ? tc.steps : [{ stepNumber: 1, action: '', testData: '', expectedResult: '' }]
    steps.forEach((step, idx) => {
      const firstRowOnly = (val: string) => (idx === 0 ? escapeCSV(val) : '')
      rows.push([
        firstRowOnly(`${tc.id}: ${tc.summary}`),
        firstRowOnly(tc.priority || 'Medium'),
        idx === 0 ? 'Draft' : '',
        firstRowOnly(tc.precondition || ''),
        firstRowOnly(tc.labels || ''),
        firstRowOnly(tc.component || ''),
        escapeCSV(step.action || ''),
        escapeCSV(step.testData || ''),
        escapeCSV(step.expectedResult || '')
      ].join(','))
    })
  }

  const csv = rows.join('\n')
  if (download) downloadCSVFile(csv, `test-cases-${sanitizeName(specId)}-zephyr-import.csv`)
  return csv
}

// ─── Xray Test Case Importer (one row per step) ──────────────────────────────
export function exportTestCasesAsXrayCSV(testCases: TestCase[], specId: string, download = true): string {
  const headers = ['Test ID', 'Test Summary', 'Test Type', 'Test Priority', 'Precondition', 'Action', 'Data', 'Expected Result', 'Labels']
  const rows: string[] = [headers.join(',')]

  for (const tc of testCases) {
    const steps = tc.steps?.length ? tc.steps : [{ stepNumber: 1, action: '', testData: '', expectedResult: '' }]
    for (const step of steps) {
      rows.push([
        escapeCSV(tc.id),
        escapeCSV(tc.summary),
        'Manual',
        escapeCSV(tc.priority || 'Medium'),
        escapeCSV(tc.precondition || ''),
        escapeCSV(step.action || ''),
        escapeCSV(step.testData || ''),
        escapeCSV(step.expectedResult || ''),
        escapeCSV(tc.labels || '')
      ].join(','))
    }
  }

  const csv = rows.join('\n')
  if (download) downloadCSVFile(csv, `test-cases-${sanitizeName(specId)}-xray-import.csv`)
  return csv
}

// ─── TestRail importer (one row per case) ────────────────────────────────────
const TESTRAIL_PRIORITY: Record<string, string> = {
  Critical: '4 - Critical',
  High: '3 - High',
  Medium: '2 - Medium',
  Low: '1 - Low'
}

export function exportTestCasesAsTestRailCSV(testCases: TestCase[], specId: string, download = true): string {
  const headers = ['Title', 'Section', 'Type', 'Priority', 'Preconditions', 'Steps', 'Expected Result']
  const rows: string[] = [headers.join(',')]

  for (const tc of testCases) {
    const steps = tc.steps || []
    const stepsText = steps
      .map(s => `${s.stepNumber}. ${s.action}${s.testData && s.testData !== 'N/A' ? ` [Data: ${s.testData}]` : ''}`)
      .join('\n')
    const expectedText = steps.map(s => `${s.stepNumber}. ${s.expectedResult}`).join('\n')
    rows.push([
      escapeCSV(`${tc.id}: ${tc.summary}`),
      escapeCSV(tc.component || 'Generated'),
      escapeCSV(tc.testType || 'Functional'),
      escapeCSV(TESTRAIL_PRIORITY[tc.priority] || TESTRAIL_PRIORITY.Medium),
      escapeCSV(tc.precondition || ''),
      escapeCSV(stepsText),
      escapeCSV(expectedText)
    ].join(','))
  }

  const csv = rows.join('\n')
  if (download) downloadCSVFile(csv, `test-cases-${sanitizeName(specId)}-testrail-import.csv`)
  return csv
}

export function exportTestCasesAsJSON(testCases: TestCase[], specId: string) {
  triggerDownload(
    new Blob([JSON.stringify(testCases, null, 2)], { type: 'application/json' }),
    `test-cases-${sanitizeName(specId)}.json`
  )
}

// ─── Playwright suite as a runnable ZIP ──────────────────────────────────────
export async function exportPlaywrightAsZip(
  data: PlaywrightAutomationData,
  specId: string,
  download = true
): Promise<Blob> {
  const zip = new JSZip()
  const folderName = `playwright-suite-${sanitizeName(specId)}`
  const folder = zip.folder(folderName)
  if (!folder) throw new Error('Failed to create ZIP folder')

  folder.file('README.md', data.readme)
  folder.file('package.json', data.packageJson)
  folder.file('tsconfig.json', data.tsconfigJson)
  folder.file('playwright.config.ts', data.playwrightConfig)
  // JSZip resolves nested paths in the filename automatically.
  data.testFiles.forEach(file => folder.file(file.filename, file.code))

  const content = await zip.generateAsync({ type: 'blob' })
  if (download) triggerDownload(content, `${folderName}.zip`)
  return content
}

// ─── Parse CSV back to TestCases ───────────────────────────────────────────────
const normalizeHeader = (str: string): string => {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function parseCSVToTestCases(csvText: string): TestCase[] {
  const lines: string[] = []
  let currentLine = ''
  let inQuotes = false

  // Split lines while respecting newlines inside quotes
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i]
    if (char === '"') {
      inQuotes = !inQuotes
      currentLine += char
    } else if (char === '\n' && !inQuotes) {
      lines.push(currentLine)
      currentLine = ''
    } else {
      currentLine += char
    }
  }
  if (currentLine) lines.push(currentLine)

  if (lines.length <= 1) return []

  // Auto-detect delimiter: comma, semicolon, tab, or pipe
  const firstLine = lines[0] || ''
  let delimiter = ','
  const delimiters = [',', ';', '\t', '|']
  let maxCount = -1
  for (const d of delimiters) {
    let count = 0
    let inside = false
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '"') {
        inside = !inside
      } else if (firstLine[i] === d && !inside) {
        count++
      }
    }
    if (count > maxCount) {
      maxCount = count
      delimiter = d
    }
  }
  if (maxCount <= 0) {
    delimiter = ','
  }

  // Parse CSV row respecting quoted strings and custom delimiter
  const parseCSVRow = (rowText: string): string[] => {
    const cells: string[] = []
    let currentCell = ''
    let inside = false
    for (let i = 0; i < rowText.length; i++) {
      const char = rowText[i]
      if (char === '"') {
        if (inside && rowText[i + 1] === '"') {
          currentCell += '"'
          i++ // skip next quote
        } else {
          inside = !inside
        }
      } else if (char === delimiter && !inside) {
        cells.push(currentCell.trim())
        currentCell = ''
      } else {
        currentCell += char
      }
    }
    cells.push(currentCell.trim())
    return cells
  }

  const headers = parseCSVRow(lines[0])
  const getColIndex = (names: string[]): number => {
    const normalizedNames = names.map(n => normalizeHeader(n))
    
    // 1. Try exact matches on normalized headers
    let idx = headers.findIndex(h => {
      const val = normalizeHeader(h)
      return normalizedNames.some(n => val === n)
    })
    if (idx !== -1) return idx

    // 2. Try substring match on normalized headers (e.g. "namesummary" includes "summary")
    idx = headers.findIndex(h => {
      const val = normalizeHeader(h)
      return normalizedNames.some(n => val.includes(n) || n.includes(val))
    })
    return idx
  }

  // Expanded aliases mapping
  let colSummary = getColIndex(['summary', 'name', 'title', 'subject', 'testcase', 'test case', 'scenario', 'feature', 'test case summary', 'test case title', 'test summary'])
  if (colSummary === -1 && headers.length > 0) colSummary = 0 // Fallback to first column

  const colIssueType = getColIndex(['issue type', 'issue_type', 'type', 'tracker'])
  const colPriority = getColIndex(['priority', 'severity', 'importance'])
  const colLabels = getColIndex(['labels', 'tags', 'label', 'tag'])
  const colTestType = getColIndex(['test type', 'test_type', 'type of test'])
  const colScenarioType = getColIndex(['scenario type', 'scenario_type', 'scenario'])
  const colComponent = getColIndex(['component', 'module', 'section', 'feature area'])
  const colEstTime = getColIndex(['estimated time', 'estimated_time', 'time', 'duration', 'est time'])
  
  const colPrecondition = getColIndex(['precondition', 'preconditions', 'objective', 'description', 'pre-condition', 'test precondition', 'summary description'])
  
  const colStepNum = getColIndex(['step #', 'step_number', 'step', 'index', 'step no', 'step number', 'number'])
  
  let colStepAction = getColIndex(['step action', 'step_action', 'action', 'step description', 'steps', 'test steps', 'step content', 'description of step'])
  // Collision check: if step action matches summary or precondition (e.g. because of the word "description"), resolve it correctly
  if (colStepAction === colSummary || colStepAction === colPrecondition) {
    colStepAction = headers.findIndex((h, index) => 
      index !== colSummary && 
      index !== colPrecondition && 
      (h.toLowerCase().includes('action') || h.toLowerCase().includes('step') || h.toLowerCase().includes('description'))
    )
  }
  
  const colStepData = getColIndex(['step data', 'step_data', 'data', 'test data', 'input', 'test_data', 'step input'])
  const colStepExpected = getColIndex(['step expected result', 'step_expected_result', 'expected', 'expected result', 'result', 'expected_result', 'step expected', 'expected outcome'])
  const colStatus = getColIndex(['status', 'state', 'result status'])

  const testCases: TestCase[] = []
  let currentTC: TestCase | null = null
  let idCounter = 1

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cells = parseCSVRow(lines[i])
    if (cells.length === 0) continue

    // The summary is only populated on the first row of a test case
    const summary = colSummary !== -1 && cells[colSummary] ? cells[colSummary] : ''

    if (summary) {
      // Create new TestCase
      currentTC = {
        id: `TC-${String(idCounter++).padStart(3, '0')}`,
        summary,
        issueType: colIssueType !== -1 ? cells[colIssueType] : 'Test',
        priority: colPriority !== -1 ? cells[colPriority] : 'Medium',
        labels: colLabels !== -1 ? cells[colLabels] : '',
        testType: colTestType !== -1 ? cells[colTestType] : 'Functional',
        scenarioType: (colScenarioType !== -1 && cells[colScenarioType] ? cells[colScenarioType] : 'happy_path') as any,
        component: colComponent !== -1 ? cells[colComponent] : '',
        estimatedTime: colEstTime !== -1 ? cells[colEstTime] : '15m',
        precondition: colPrecondition !== -1 ? cells[colPrecondition] : '',
        steps: [],
        status: colStatus !== -1 ? cells[colStatus] : 'Not Executed',
      }
      testCases.push(currentTC)
    }

    // Add steps to currentTestCase
    if (currentTC) {
      const action = colStepAction !== -1 ? cells[colStepAction] : ''
      const expectedResult = colStepExpected !== -1 ? cells[colStepExpected] : ''
      const testData = colStepData !== -1 ? cells[colStepData] : 'N/A'

      if (action || expectedResult) {
        let stepNum = currentTC.steps.length + 1
        if (colStepNum !== -1 && cells[colStepNum]) {
          const parsedNum = parseInt(cells[colStepNum], 10)
          if (!isNaN(parsedNum)) stepNum = parsedNum
        }
        currentTC.steps.push({
          stepNumber: stepNum,
          action: action || 'Perform action',
          testData: testData || 'N/A',
          expectedResult: expectedResult || 'Action completed successfully'
        })
      }
    }
  }

  return testCases
}

export async function parseExcelToCSV(file: File): Promise<string> {
  await loadCdnScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')
  const XLSX = (window as any).XLSX
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]
  return XLSX.utils.sheet_to_csv(worksheet)
}
