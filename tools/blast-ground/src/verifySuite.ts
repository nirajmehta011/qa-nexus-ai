/**
 * blast-ground verify-suite <dir>
 *
 * The pre-delivery smoke gate: install, typecheck, and actually RUN the
 * generated Playwright framework against its target before calling it done.
 * This is what would have caught "0 tests in 0 files" (a SyntaxError in the
 * locators file) and "TypeError: home.getAllProductCards is not a function"
 * immediately, instead of shipping a framework whose only real test was
 * already known-broken.
 *
 * Every child process is spawned with an argv array – never a shell string –
 * so nothing here is vulnerable to command injection via a project path.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

interface StepResult {
  step: string
  ok: boolean
  summary: string
  detail?: string
}

export interface VerifyReport {
  dir: string
  ok: boolean
  steps: StepResult[]
  tests?: { total: number; passed: number; failed: number; skipped: number; flaky: number }
  failures?: { title: string; error: string }[]
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', err => resolve({ code: 1, stdout, stderr: stderr + String(err) }))
  })
}

// Walks the Playwright JSON reporter's suite tree to pull out failure detail
// the top-level `stats` block doesn't carry.
function collectFailures(node: any, out: { title: string; error: string }[] = []): { title: string; error: string }[] {
  for (const spec of node.specs || []) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        if (result.status === 'failed' || result.status === 'timedOut') {
          const message = result.error?.message || result.errors?.[0]?.message || 'no error message captured'
          out.push({ title: spec.title, error: String(message).split('\n')[0].slice(0, 200) })
        }
      }
    }
  }
  for (const suite of node.suites || []) collectFailures(suite, out)
  return out
}

export async function verifySuite(dir: string, opts: { baseUrl?: string; skipBrowserInstall?: boolean }): Promise<VerifyReport> {
  const steps: StepResult[] = []
  const report: VerifyReport = { dir, ok: true, steps }

  if (!existsSync(join(dir, 'package.json'))) {
    steps.push({ step: 'preflight', ok: false, summary: `No package.json in ${dir} – is this a generated framework directory?` })
    report.ok = false
    return report
  }

  // 1. Install
  if (!existsSync(join(dir, 'node_modules'))) {
    process.stderr.write('→ npm install\n')
    const install = await run('npm', ['install'], dir)
    steps.push({
      step: 'install',
      ok: install.code === 0,
      summary: install.code === 0 ? 'dependencies installed' : 'npm install failed',
      detail: install.code === 0 ? undefined : install.stderr.slice(-2000)
    })
    if (install.code !== 0) { report.ok = false; return report }
  } else {
    steps.push({ step: 'install', ok: true, summary: 'node_modules already present, skipped' })
  }

  // 2. Browser binary
  if (!opts.skipBrowserInstall) {
    process.stderr.write('→ npx playwright install chromium\n')
    const browser = await run('npx', ['playwright', 'install', 'chromium'], dir)
    steps.push({
      step: 'browser-install',
      ok: browser.code === 0,
      summary: browser.code === 0 ? 'chromium ready' : 'playwright install failed',
      detail: browser.code === 0 ? undefined : browser.stderr.slice(-2000)
    })
    if (browser.code !== 0) { report.ok = false; return report }
  }

  // 3. Typecheck – catches a SyntaxError/undefined-method framework before a
  //    single browser is launched (the #7/#1 defects from the real-world audits).
  process.stderr.write('→ npx tsc --noEmit\n')
  const typecheck = await run('npx', ['tsc', '--noEmit'], dir)
  steps.push({
    step: 'typecheck',
    ok: typecheck.code === 0,
    summary: typecheck.code === 0 ? 'tsc --noEmit passed' : 'tsc --noEmit found errors',
    detail: typecheck.code === 0 ? undefined : (typecheck.stdout + typecheck.stderr).slice(0, 4000)
  })
  if (typecheck.code !== 0) {
    report.ok = false
    return report // running tests against code that doesn't compile is not informative
  }

  // 4. Actually run the suite against the real target.
  const resultsFile = join(mkdtempSync(join(tmpdir(), 'blast-ground-')), 'results.json')
  process.stderr.write('→ npx playwright test\n')
  const testRun = await run(
    'npx',
    ['playwright', 'test', '--reporter=json'],
    dir,
    { PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile, ...(opts.baseUrl ? { BASE_URL: opts.baseUrl } : {}) }
  )

  let parsed: any = null
  try {
    parsed = JSON.parse(readFileSync(resultsFile, 'utf8'))
  } catch {
    // Playwright itself failed to run (e.g. config error) – no JSON to parse.
  } finally {
    rmSync(resultsFile, { force: true })
  }

  if (!parsed) {
    steps.push({ step: 'run', ok: false, summary: 'Playwright did not produce a results file', detail: (testRun.stdout + testRun.stderr).slice(-2000) })
    report.ok = false
    return report
  }

  const stats = parsed.stats || {}
  const failures = parsed.suites?.flatMap((s: any) => collectFailures(s)) || []
  report.tests = {
    total: (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.skipped ?? 0) + (stats.flaky ?? 0),
    passed: stats.expected ?? 0,
    failed: stats.unexpected ?? 0,
    skipped: stats.skipped ?? 0,
    flaky: stats.flaky ?? 0
  }
  report.failures = failures

  // A run is "ok" if nothing UNEXPECTEDLY failed. test.fixme specs report as
  // "skipped", not "failed" – a framework that is honestly incomplete (via
  // todoSelector/fixme) still passes this gate; one that crashes does not.
  const ok = report.tests.failed === 0
  steps.push({
    step: 'run',
    ok,
    summary: `${report.tests.passed} passed, ${report.tests.failed} failed, ${report.tests.skipped} skipped (fixme/todo)`
  })
  report.ok = ok
  return report
}

export function printReport(report: VerifyReport) {
  process.stderr.write('\n── verify-suite ──────────────────────────────────────────\n')
  for (const step of report.steps) {
    process.stderr.write(`${step.ok ? '✓' : '✗'} ${step.step}: ${step.summary}\n`)
    if (!step.ok && step.detail) process.stderr.write(step.detail.split('\n').map(l => `    ${l}`).join('\n') + '\n')
  }
  if (report.failures && report.failures.length > 0) {
    process.stderr.write('\nFailed tests:\n')
    for (const f of report.failures) process.stderr.write(`  ✗ ${f.title}\n    ${f.error}\n`)
  }
  process.stderr.write(`\n${report.ok ? '✅ verify-suite passed' : '❌ verify-suite failed'} — ${report.dir}\n`)
}
