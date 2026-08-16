import { z } from 'zod'
import type { CollectionEntry, ElementEntry } from './domDistiller'

/**
 * Import a `grounding.json` produced by the `blast-ground` CLI.
 *
 * Every selector in that file was resolved against a LIVE page and matched
 * exactly one element; every route was confirmed to exist. That is a stronger
 * guarantee than anything static parsing can offer, so the generator trusts it:
 * it skips its own HTTP route check and treats the selectors as verified.
 *
 * Anything the CLI could not verify arrives in `unresolved` and is deliberately
 * NOT turned into a selector — those become honest `todoSelector()` stubs.
 */

const kindSchema = z.enum(['button', 'link', 'input', 'select', 'textarea', 'checkbox', 'radio', 'other'])

const elementSchema = z.object({
  selector: z.string().min(1),
  tag: z.string(),
  label: z.string(),
  kind: kindSchema,
  page: z.string().optional(),
  verifiedCount: z.number().optional()
})

const collectionSchema = z.object({
  name: z.string(),
  itemSelector: z.string().min(1),
  count: z.coerce.number(),
  fields: z
    .array(z.object({ name: z.string(), selector: z.string().min(1), kind: kindSchema }))
    .default([]),
  page: z.string().optional(),
  nondeterministicOrder: z.boolean().optional()
})

export const GroundingFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().optional(),
  baseUrl: z.string().url(),
  pages: z.array(z.object({ name: z.string(), url: z.string() })).default([]),
  elements: z.array(elementSchema).default([]),
  collections: z.array(collectionSchema).default([]),
  routes: z
    .object({ valid: z.array(z.string()).default([]), missing: z.array(z.string()).default([]) })
    .default({ valid: [], missing: [] }),
  unresolved: z
    .array(z.object({ label: z.string(), reason: z.string(), kind: kindSchema.optional(), tried: z.array(z.string()).optional() }))
    .default([]),
  warnings: z.array(z.string()).default([])
})

export type GroundingFile = z.infer<typeof GroundingFileSchema>

export interface ParsedGrounding {
  baseUrl: string
  elements: ElementEntry[]
  collections: CollectionEntry[]
  missingRoutes: string[]
  /** Elements the live browser could not pin down – they stay ungrounded, on purpose. */
  unresolvedLabels: string[]
  warnings: string[]
  pageNames: string[]
  /** Page name -> the exact URL it was grounded at (e.g. for auth setup to navigate to the real login page). */
  pageUrls: Record<string, string>
}

/** Throws a human-readable error when the file isn't a valid grounding export. */
export function parseGroundingFile(raw: unknown): ParsedGrounding {
  const result = GroundingFileSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first?.path.join('.') || 'file'
    throw new Error(`Not a valid grounding.json (${where}: ${first?.message ?? 'unknown error'}). Generate one with: npx blast-ground <url>`)
  }
  const file = result.data

  return {
    baseUrl: file.baseUrl,
    // Drop verifiedCount: the app's ElementEntry has no such field, and its
    // presence is already implied by the element being here at all.
    elements: file.elements.map(({ verifiedCount: _ignored, ...element }) => element),
    collections: file.collections,
    missingRoutes: file.routes.missing,
    unresolvedLabels: file.unresolved.map(u => u.label),
    warnings: [
      ...file.warnings,
      // Newer CLI builds already warn about unstable ordering themselves; only
      // synthesize the message for a selector nothing has flagged yet, or the
      // panel shows the same caution twice.
      ...file.collections
        .filter(c => c.nondeterministicOrder && !file.warnings.some(w => w.includes(c.itemSelector)))
        .map(c => `"${c.itemSelector}" reorders itself between page loads – address its items by text, never by index.`),
      ...(file.unresolved.length > 0
        ? [`${file.unresolved.length} element(s) could not be uniquely resolved on the live page and will be left as todoSelector() stubs rather than guessed.`]
        : [])
    ],
    pageNames: file.pages.map(p => p.name),
    pageUrls: Object.fromEntries(file.pages.map(p => [p.name, p.url]))
  }
}
