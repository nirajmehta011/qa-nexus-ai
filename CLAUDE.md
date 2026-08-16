# QA Nexus AI — Hackathon Build Playbook

## Context
AI Tester Hackathon, **today (16 Aug 2026), hard deadline 11:00 PM IST** — any commit after that = disqualification. Final commit target: **10:30 PM**. Submission needs: public GitHub repo, working Vercel deployment, complete README (title, problem, solution, tech stack, how to run, demo link, screenshots), Google Form with both links.

Judging criteria: Idea & Innovation, AI Implementation, Functionality, Code Quality, Documentation, UI/UX.

## What this app is
Single killer flow: **spec input (URL / uploaded doc / Jira ID) → AI-generated Jira/Zephyr test cases → framework-aware Playwright TS POM automation suite → ZIP export.**

Differentiator (built fresh today): **Framework-aware generation** — user uploads their existing test framework (zip or folder via directory picker, parsed client-side with JSZip / webkitdirectory), we extract page objects + naming conventions client-side and inject them into the generation prompt so generated specs **reuse the user's own page classes and style** instead of inventing generic ones. Demo story: same test case, before vs. after framework upload.

Stretch (only if green by ~8 PM): lightweight per-test-case confidence badge via a second LLM judge pass.

## Explicitly OUT of scope (do not port)
Test strategy page, IEEE 829 test plan, Jira push panel, execution panel, gap analysis. They exist in the old app; porting them dilutes the demo and eats the clock.

## Source to port from
`/Users/nirajmehta/Documents/AI Projects/BLAST FW/app` — the original QA Nexus. Port selectively:
- `src/services/`: aiService.ts, schemas.ts, jsonParser.ts, exportService.ts, jiraService.ts, storageService.ts, errorUtils.ts, pomBuilder.ts, automationBuilder.ts, automationTemplates.ts, codegenParser.ts (+ their .test.ts files)
- `src/components/`: Header, LeftPanel, JiraIDInput, TestCasesDisplay, ExportButtons (adapt; skip strategy/plan/execution components)
- `src/context/SettingsContext.tsx` (multi-provider key vault)
- `server/` proxy + `api/index.mjs` + `vercel.json` — already copied into this repo.

## Schedule (IST)
- ~2:00 PM: scaffold pushed, Vercel connected, blank app live  ← done first, always
- 2:00–4:30: port core generation flow (spec input → test cases)
- 4:30–6:15: port automation module (POM builder + ZIP export)
- 6:15–8:00: BUILD framework-aware generation (the new feature)
- 8:00–8:30: stretch: confidence badges
- 8:30–9:15: README to the required template + screenshots
- 9:15–10:15: end-to-end verification ON THE DEPLOYED VERCEL URL
- 10:15–10:45: buffer, final commit, submit Google Form (verify links in incognito)

## Working rules
1. Redeploy + smoke-test on Vercel after every block, never only at the end.
2. Commit per logical chunk with honest messages ("port AI service layer", "add framework convention extractor").
3. If automation port isn't working by 6:30 PM, cut it — test cases + framework-aware generation is still a complete demo.
4. API keys are user-entered in the UI (per-provider vault), never committed. `.env` is gitignored.
5. `npm run build` and `npm test` must pass before every push (Vercel runs the same build).
6. Local dev: `npm run dev:full` (Vite on 5173 + Express proxy on 3001). On Vercel, `api/index.mjs` serves the proxy.
