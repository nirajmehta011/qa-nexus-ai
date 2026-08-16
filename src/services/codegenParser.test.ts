import { describe, it, expect } from 'vitest'
import { parseCodegenScript, recordedLocators, mergeActions, derivePageName } from './codegenParser'

const CODEGEN_SAMPLE = `
import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://app.example.com/login');
  await page.getByPlaceholder('Email address').fill('user@example.com');
  await page.getByPlaceholder('Password').fill('Secret123!');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('#theme-select').selectOption('dark');
  await page.getByRole('row', { name: 'Item 1' }).filter({ hasText: 'active' }).first().click();
  await page.getByLabel('Remember me').check();
  await page.goto('https://app.example.com/dashboard');
  await page.getByRole('button', { name: 'Log out' }).click();
});
`

describe('parseCodegenScript', () => {
  const result = parseCodegenScript(CODEGEN_SAMPLE)

  it('extracts all recorded actions with locators', () => {
    expect(result.actions.length).toBe(8)
    const actions = result.actions.map(a => a.action)
    expect(actions).toContain('fill')
    expect(actions).toContain('click')
    expect(actions).toContain('selectOption')
    expect(actions).toContain('check')
  })

  it('captures fill values', () => {
    const emailFill = result.actions.find(a => a.locator.includes('Email address'))
    expect(emailFill?.value).toBe('user@example.com')
  })

  it('handles chained locators (filter/first)', () => {
    const chained = result.actions.find(a => a.locator.includes('filter'))
    expect(chained).toBeDefined()
    expect(chained!.action).toBe('click')
  })

  it('collects visited urls', () => {
    expect(result.urls).toEqual(['https://app.example.com/login', 'https://app.example.com/dashboard'])
  })

  it('returns unique locators for the allow-list', () => {
    const locators = recordedLocators(result)
    expect(locators).toContain("page.getByRole('button', { name: 'Log in' })")
    expect(new Set(locators).size).toBe(locators.length)
  })

  it('returns empty result for non-playwright text', () => {
    const empty = parseCodegenScript('const x = 1; // nothing here')
    expect(empty.actions).toHaveLength(0)
    expect(empty.urls).toHaveLength(0)
  })
})

describe('page segmentation', () => {
  it('tags actions with the page derived from the preceding goto()', () => {
    const result = parseCodegenScript(CODEGEN_SAMPLE)
    const loginActions = result.actions.filter(a => a.page === 'Login')
    const dashboardActions = result.actions.filter(a => a.page === 'Dashboard')
    expect(loginActions.length).toBeGreaterThan(0)
    expect(dashboardActions.length).toBeGreaterThan(0)
    // fill/click on email+password happen before the dashboard goto
    expect(loginActions.some(a => a.locator.includes('Email address'))).toBe(true)
  })

  it('falls back to a default page name when there is no goto()', () => {
    const script = `await page.getByRole('button', { name: 'Submit' }).click();`
    const result = parseCodegenScript(script, 'Checkout')
    expect(result.actions[0].page).toBe('Checkout')
  })
})

describe('derivePageName', () => {
  it('titles the last path segment', () => {
    expect(derivePageName('https://app.example.com/user-settings')).toBe('User Settings')
  })
  it('falls back to Home for the root path', () => {
    expect(derivePageName('https://app.example.com/')).toBe('Home')
  })
  it('falls back to App for an unparsable URL', () => {
    expect(derivePageName('not a url')).toBe('App')
  })
})

describe('mergeActions', () => {
  const a = { locator: "page.getByRole('button', { name: 'Log in' })", action: 'click' }
  const b = { locator: "page.getByLabel('Remember me')", action: 'check' }

  it('accumulates actions from multiple recordings', () => {
    expect(mergeActions([a], [b])).toEqual([a, b])
  })

  it('deduplicates identical locator+action+value combos', () => {
    expect(mergeActions([a], [a])).toEqual([a])
  })

  it('keeps distinct actions on the same locator (e.g. fill then click)', () => {
    const fill = { locator: "page.getByPlaceholder('Email')", action: 'fill', value: 'a@b.com' }
    const click = { locator: "page.getByPlaceholder('Email')", action: 'click' }
    expect(mergeActions([fill], [click])).toEqual([fill, click])
  })
})
