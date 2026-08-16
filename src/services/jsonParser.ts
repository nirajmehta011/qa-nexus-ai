import { jsonrepair } from 'jsonrepair'
import type { ZodType } from 'zod'

export class ParseError extends Error {
  constructor(message: string, public readonly rawExcerpt: string) {
    super(message)
    this.name = 'ParseError'
  }
}

// Extraction: strip markdown code fences and slice to the outermost JSON
// bracket pair, then a strict parse. Smaller/faster models occasionally slip
// on an unescaped quote or a trailing comma, or get cut off mid-array by an
// output-token ceiling — on a strict-parse failure we fall back to jsonrepair
// (a real tokenizing repair pass: unescaped quotes, missing/trailing commas,
// unterminated strings and arrays), which recovers most of these for free and
// without spending an extra model round-trip. It's a purpose-built library,
// not hand-rolled regex substitution — the latter risks corrupting legitimate
// test data that happens to contain quote characters, which is why this file
// never did blind find-replace "repairs" on the raw text.
export function extractJson(raw: string): unknown {
  if (!raw || !raw.trim()) {
    throw new ParseError('AI returned an empty response', '')
  }

  let text = raw.trim()

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const firstBracket = text.search(/[[{]/)
  if (firstBracket === -1) {
    throw new ParseError(
      'AI response contains no JSON',
      text.slice(0, 200)
    )
  }
  const open = text[firstBracket]
  const close = open === '[' ? ']' : '}'
  const lastBracket = text.lastIndexOf(close)
  if (lastBracket <= firstBracket) {
    throw new ParseError(
      `AI response has an unterminated JSON ${open === '[' ? 'array' : 'object'}`,
      text.slice(firstBracket, firstBracket + 200)
    )
  }
  text = text.slice(firstBracket, lastBracket + 1)

  try {
    return JSON.parse(text)
  } catch (err: any) {
    try {
      return JSON.parse(jsonrepair(text))
    } catch {
      // Repair didn't help – report the original, more specific parse error.
    }
    const posMatch = /position (\d+)/.exec(err.message || '')
    const pos = posMatch ? Number(posMatch[1]) : 0
    const excerpt = text.slice(Math.max(0, pos - 100), pos + 100)
    throw new ParseError(`Invalid JSON: ${err.message}`, excerpt)
  }
}

export type RepairFn = (errorMessage: string, badOutput: string) => Promise<string>

// Parse + schema-validate, with exactly ONE repair round-trip carrying the
// real error back to the model. Still invalid after repair → throw loudly.
export async function parseWithRepair<T>(
  raw: string,
  schema: ZodType<T, any, any>,
  repair?: RepairFn
): Promise<T> {
  const attempt = (text: string): { ok: true; data: T } | { ok: false; error: string } => {
    let parsed: unknown
    try {
      parsed = extractJson(text)
    } catch (err: any) {
      const excerpt = err instanceof ParseError && err.rawExcerpt ? ` Near: "${err.rawExcerpt}"` : ''
      return { ok: false, error: `${err.message}.${excerpt}` }
    }
    const result = schema.safeParse(parsed)
    if (result.success) return { ok: true, data: result.data }
    const issues = result.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `Schema validation failed – ${issues}` }
  }

  const first = attempt(raw)
  if (first.ok) return first.data

  if (!repair) {
    throw new Error(`AI response could not be parsed: ${first.error}`)
  }

  const repaired = await repair(first.error, raw.slice(0, 6000))
  const second = attempt(repaired)
  if (second.ok) return second.data

  throw new Error(
    `AI response could not be parsed even after a repair attempt: ${second.error}`
  )
}
