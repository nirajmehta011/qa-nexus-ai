# QA Nexus AI — working notes

## What this app is
One flow: **spec input (URL / uploaded document / Jira ID / pasted text) → AI-generated test cases →
framework-aware Playwright TS Page Object Model suite → ZIP export.**

The differentiator is **framework-aware generation**. The user uploads their existing Playwright repo (a `.zip`
or a folder via the directory picker). It is parsed entirely client-side with JSZip; page-object classes,
method signatures, fixtures and naming conventions are extracted and injected into the generation prompt, so
generated specs reuse the user's own page classes and style instead of inventing generic ones.

The clearest way to show the value: generate the same test case twice, once without a framework and once with.

## Architecture
- `src/services/aiService.ts` — provider-agnostic LLM layer (Groq / Gemini / OpenAI / OpenRouter) plus every
  generation prompt. All prompts live here; nothing else builds prompt text.
- `src/services/frameworkAnalyzer.ts` — the differentiator. Parses uploaded source, produces a
  `FrameworkProfile`, and renders it into the prompt fragment via `buildFrameworkPromptContext`.
- `src/services/automationBuilder.ts` — turns the model's page-objects/specs payload into a scaffolded,
  validated project. Contract checks live here.
- `src/services/automationTemplates.ts` — deterministic project scaffold. If something is identical every
  time, it belongs here, not in a prompt.
- `src/services/schemas.ts` — Zod contracts for every model response.
- `server/` + `api/index.mjs` — the same Express routers, run locally and on Vercel.

## Conventions
1. **Every model response is schema-validated** through `parseWithRepair` with exactly one informed repair
   round-trip. Never trust raw model JSON.
2. **Report contract violations, don't auto-fix them.** Silently rewriting generated code hides that the model
   went off-framework.
3. **Never guess a selector silently.** Anything not derivable from the spec is a marked `TODO-SELECTOR` and is
   surfaced in the UI.
4. **API keys are user-entered in the UI** (per-provider vault in `SettingsContext`), stored in `localStorage`,
   never committed and never persisted server-side. `.env` is gitignored.
5. **Styling goes through the design tokens** in `src/styles/globals.css`. Both themes (Latte light, Midnight
   dark) share one token set, so components are written once — no hardcoded colours in components.
6. `npm run build` and `npm test` must both pass before every push; Vercel runs the same build.

## Deliberately out of scope
Test strategy documents, IEEE 829 test plans, Jira push, in-app test execution, and coverage gap analysis.
They dilute the single flow this app is good at.

## Local development
```bash
npm run dev:full   # Vite on :5173 + Express proxy on :3001
```
On Vercel, `api/index.mjs` serves the proxy. If :5173 or :3001 are taken, override with
`BACKEND_PORT` and `VITE_API_URL`.
