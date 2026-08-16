import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { extractJson, parseWithRepair, ParseError } from './jsonParser'

describe('extractJson', () => {
  it('parses plain JSON arrays and objects', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3])
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it('strips markdown code fences', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```\n[1]\n```')).toEqual([1])
  })

  it('slices to the JSON payload when surrounded by prose', () => {
    expect(extractJson('Here are your test cases:\n[{"id": "TC-001"}]\nHope this helps!')).toEqual([
      { id: 'TC-001' }
    ])
  })

  it('handles nested brackets without corruption', () => {
    const payload = { testCases: [{ steps: [{ action: 'click [Save] button' }] }] }
    expect(extractJson(JSON.stringify(payload))).toEqual(payload)
  })

  it('never mutates string content (single quotes, control-like text preserved)', () => {
    const payload = { summary: "user's data with 'quotes' and trailing, comma" }
    expect(extractJson(JSON.stringify(payload))).toEqual(payload)
  })

  it('throws ParseError on empty input', () => {
    expect(() => extractJson('')).toThrow(ParseError)
    expect(() => extractJson('   ')).toThrow(ParseError)
  })

  it('throws ParseError with context when no JSON present', () => {
    expect(() => extractJson('Sorry, I cannot help with that.')).toThrow(/contains no JSON/)
  })

  it('throws ParseError on truncated JSON with no recoverable structure', () => {
    expect(() => extractJson('[{"id": "TC-001", "summary": "trunc')).toThrow(ParseError)
  })

  // Reproduces the actual reported failure: a smaller/faster model slips on
  // JSON formatting (a trailing comma, or a raw newline inside a string) and
  // the previous strict-only parser discarded the whole response over it.
  it('recovers a trailing comma before a closing bracket', () => {
    const text = '[{"id": "TC-001", "summary": "ok"},]'
    expect(extractJson(text)).toEqual([{ id: 'TC-001', summary: 'ok' }])
  })

  it('recovers a raw (unescaped) newline inside a string value', () => {
    const text = '[{"id": "TC-001", "expectedResult": "Line one\nLine two"}]'
    const result = extractJson(text) as any[]
    expect(result[0].id).toBe('TC-001')
    expect(result[0].expectedResult).toContain('Line one')
    expect(result[0].expectedResult).toContain('Line two')
  })

  it('recovers a missing comma between properties', () => {
    const text = '[{"id": "TC-001" "summary": "missing comma above"}]'
    expect(extractJson(text)).toEqual([{ id: 'TC-001', summary: 'missing comma above' }])
  })
})

describe('parseWithRepair', () => {
  const schema = z.object({ value: z.number() })

  it('returns parsed data on first-try success without calling repair', async () => {
    const repair = vi.fn()
    const result = await parseWithRepair('{"value": 42}', schema, repair)
    expect(result).toEqual({ value: 42 })
    expect(repair).not.toHaveBeenCalled()
  })

  it('calls repair exactly once with the real error message', async () => {
    const repair = vi.fn().mockResolvedValue('{"value": 42}')
    const result = await parseWithRepair('{"value": "not-a-number"}', schema, repair)
    expect(result).toEqual({ value: 42 })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair.mock.calls[0][0]).toMatch(/value/)
  })

  it('throws a descriptive error when repair also fails', async () => {
    const repair = vi.fn().mockResolvedValue('still broken')
    await expect(parseWithRepair('nonsense', schema, repair)).rejects.toThrow(/repair attempt/)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('throws immediately when no repair fn is provided', async () => {
    await expect(parseWithRepair('nonsense', schema)).rejects.toThrow(/could not be parsed/)
  })
})
