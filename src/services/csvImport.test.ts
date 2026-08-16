import { describe, it, expect } from 'vitest'
import { parseCSVToTestCases } from './exportService'

// Round-tripping matters: teams import the same CSV this app exports, and the
// step rows carry blank case fields that must attach to the preceding case.

const jiraStyleCsv = `Summary,Priority,Component,Precondition,Step #,Step Action,Step Data,Step Expected Result
User resets password,High,Auth,User has an account,1,Open the forgot-password page,/forgot,Reset form is displayed
,,,,2,Enter the registered email,user@example.com,Field accepts the address
,,,,3,Submit the form,N/A,Confirmation message is shown
Cart persists across sessions,Medium,Cart,Items in cart,1,Log in as the user,user@example.com,Dashboard loads
,,,,2,Open the cart,N/A,Previously added items are listed`

describe('parseCSVToTestCases', () => {
  it('groups step rows under the case that owns them', () => {
    const cases = parseCSVToTestCases(jiraStyleCsv)

    expect(cases).toHaveLength(2)
    expect(cases[0].summary).toBe('User resets password')
    expect(cases[0].steps).toHaveLength(3)
    expect(cases[0].steps[2].expectedResult).toBe('Confirmation message is shown')
    expect(cases[1].summary).toBe('Cart persists across sessions')
    expect(cases[1].steps).toHaveLength(2)
  })

  it('assigns sequential ids so imports never collide on a blank id column', () => {
    expect(parseCSVToTestCases(jiraStyleCsv).map(c => c.id)).toEqual(['TC-001', 'TC-002'])
  })

  it('carries case-level metadata from the first row', () => {
    const [first] = parseCSVToTestCases(jiraStyleCsv)
    expect(first.priority).toBe('High')
    expect(first.component).toBe('Auth')
    expect(first.precondition).toBe('User has an account')
  })

  it('handles quoted cells containing the delimiter and newlines', () => {
    const csv = `Summary,Step Action,Step Expected Result
"Search, filter and sort","Type ""shoes"" into search","Results update, sorted by relevance"`
    const [tc] = parseCSVToTestCases(csv)
    expect(tc.summary).toBe('Search, filter and sort')
    expect(tc.steps[0].action).toBe('Type "shoes" into search')
    expect(tc.steps[0].expectedResult).toBe('Results update, sorted by relevance')
  })

  it('auto-detects a semicolon-delimited export', () => {
    const csv = 'Name;Priority;Test Step;Expected Result\nLogin works;High;Click sign in;Dashboard loads'
    const [tc] = parseCSVToTestCases(csv)
    expect(tc.summary).toBe('Login works')
    expect(tc.priority).toBe('High')
    expect(tc.steps[0].action).toBe('Click sign in')
  })

  it('returns nothing for a header-only or empty file rather than throwing', () => {
    expect(parseCSVToTestCases('Summary,Step Action')).toEqual([])
    expect(parseCSVToTestCases('')).toEqual([])
  })
})
