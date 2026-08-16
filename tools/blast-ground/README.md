# blast-ground

Verify Playwright locators against a **live page**, then feed the result into the app.

Static HTML parsing can only *propose* selectors. It cannot know that a browser assigns **no ARIA role** to an `<a>` without `href`, or that `.card-title` matches four nodes rather than one. This CLI drives a real headless browser, asks it `locator.count()` for every candidate, and keeps only what resolves to **exactly one element**.

It runs on **your machine**, so it can ground `localhost`, VPN-only staging, and pages behind a login — targets a hosted service structurally cannot reach.

## Install

```bash
cd tools/blast-ground
npm install
npx playwright install chromium     # once, ~150MB
```

## Usage

```bash
# public page
npm run ground -- https://sweetshop.vivrichards.co.uk/sweets --page Sweets --out grounding.json

# localhost / VPN / staging
npm run ground -- http://localhost:3000 --page Home --out grounding.json

# behind a login (reuse a Playwright storageState file)
npm run ground -- https://app.internal/dashboard --page Dashboard \
  --storage-state ./auth.json --out grounding.json

# several screens into ONE grounding file
npm run ground -- https://site.com/login --page Login \
  --also https://site.com/dashboard=Dashboard \
  --also https://site.com/settings=Settings \
  --out grounding.json

# SPA that needs a beat to render
npm run ground -- https://spa.app --wait-for '.card' --wait 1000
```

| Flag | Purpose |
|---|---|
| `--page <Name>` | Names the primary URL's page object |
| `--also <url>=<Name>` | Ground another screen into the same file |
| `--out <file>` | Output path (default `grounding.json`) |
| `--storage-state <file>` | Playwright auth state, for logged-in pages |
| `--wait-for <selector>` | Wait for this selector before grounding |
| `--wait <ms>` | Extra settle time |
| `--headed` | Watch it work |
| `--no-routes` | Skip route discovery/checking |

## Feeding it back into the app

In the app: **3 Selector grounding → Import verified → Import grounding.json**, and select the file.

The panel flips from **best-effort (static)** to **✅ live-verified**, and the step header reads *"N live-verified selectors"*. Every selector in the file matched exactly one element; routes were confirmed to exist; anything unverifiable is listed under `unresolved` and becomes an honest `todoSelector()` stub rather than a guess.

Adding a best-effort source (Fetch URL / Paste DOM / Codegen) on top of an import **demotes the context back to best-effort** — the generator must not skip its own route check on the strength of a flag that no longer covers every selector.

No CLI to hand? The same panel has a **Try the sample** button that loads a committed run of this tool against the sweetshop demo site, so the import path is testable without installing anything.

## Verifying the suite it helped generate

```bash
npm run verify-suite -- ../../path/to/playwright-suite --base-url https://your-app.test
```

Installs, runs `tsc --noEmit`, then actually executes the suite and parses Playwright's JSON reporter:

```
── verify-suite ──────────────────────────────────────────
✓ install: dependencies installed
✓ browser-install: chromium ready
✓ typecheck: tsc --noEmit passed
✓ run: 3 passed, 0 failed, 1 skipped (fixme/todo)

✅ verify-suite passed
```

`test.fixme` specs report as **skipped**, not failed — a suite that is honestly incomplete still passes the gate; one that does not compile, or that crashes, does not.

## What it produces

```jsonc
{
  "version": 1,
  "baseUrl": "https://sweetshop.vivrichards.co.uk",
  "pages": [{ "name": "Sweets", "url": ".../sweets" }],
  "elements":    [{ "selector": "page.locator('[data-name=\"Bon Bons\"]')",
                    "label": "Add to Basket", "kind": "other",
                    "page": "Sweets", "verifiedCount": 1 }],
  "collections": [{ "itemSelector": ".card", "count": 4,
                    "fields": [{ "name": "cardTitle", "selector": ".card-title" }],
                    "nondeterministicOrder": true }],
  "routes":      { "valid": ["/sweets", "/basket"], "missing": ["/products"] },
  "unresolved":  [{ "label": "Search box",
                    "reason": "no candidate matched any element on the live page" }],
  "warnings":    ["\"card\" reorders itself between loads — address items by text, never by index."]
}
```

Two deliberate choices:

- **A selector matching many nodes is rejected, not disambiguated with `.nth(i)`.** Lists often reshuffle at runtime, and a positional locator produces *intermittently* failing tests — worse than loudly missing ones.
- **`401`/`403` routes count as valid.** They exist; they're just gated.

## Limits — what it can and cannot capture

It grounds **the rendered state of the URLs you point it at**. That is not "every locator in the app."

**Captured**
- Everything in the live, post-JavaScript DOM (including content a static fetch would miss).
- Repeating structures (product grids, result lists) as a collection + per-item fields.
- Same-origin routes actually linked from the page.

**Not captured — and no single snapshot ever could**
- **Elements that only exist after an interaction**: modals, dropdowns, tabs, toasts, wizard steps. They aren't in the DOM until you click. Use a **codegen recording** for those flows (the app already accepts one) or ground the state after you drive it there.
- **SPA modules you haven't navigated to.** Code-split routes aren't loaded yet. Pass each route with `--also` (works when the SPA uses real URLs). A route only reachable by clicking is invisible.
- **Virtualized lists** — only the rendered window exists in the DOM.
- **Content inside iframes**, and **closed** shadow DOM. (Open shadow DOM: Playwright pierces it at *query* time, but `page.content()` doesn't serialize it, so candidates aren't proposed for it.)
- **Auth-gated pages** without `--storage-state`.

So for a multi-module SPA the honest recipe is: **one `--also` per route**, plus a **codegen recording** for anything behind an interaction. This CLI removes hallucinated *locators and routes*; it does not remove the need to show the tool the states you care about.
