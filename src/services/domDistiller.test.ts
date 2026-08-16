// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { distillHtml, detectCollections, mergeElements, mergeCollections } from './domDistiller'

const SAMPLE = `
<html><body>
  <form>
    <input data-testid="email-input" type="email" placeholder="Email address" />
    <input id="password" type="password" placeholder="Password" />
    <input type="checkbox" name="remember" />
    <button type="submit">Log in</button>
    <a href="/forgot">Forgot password?</a>
    <select name="locale"><option>EN</option></select>
    <div role="button" aria-label="Close dialog">×</div>
  </form>
  <div class="decoration">not interactive</div>
</body></html>`

describe('distillHtml', () => {
  const entries = distillHtml(SAMPLE)
  const bySelector = (fragment: string) => entries.find(e => e.selector.includes(fragment))

  it('prefers data-testid over everything', () => {
    expect(bySelector("getByTestId('email-input')")).toBeDefined()
  })

  it('uses id when no testid', () => {
    expect(bySelector("locator('#password')")).toBeDefined()
  })

  it('uses role+name for buttons and links with text', () => {
    expect(bySelector("getByRole('button', { name: 'Log in' })")).toBeDefined()
    expect(bySelector("getByRole('link', { name: 'Forgot password?' })")).toBeDefined()
  })

  it('uses aria-label for labelled custom controls', () => {
    expect(bySelector("getByLabel('Close dialog')")).toBeDefined()
  })

  it('falls back to name attribute', () => {
    expect(bySelector('select[name="locale"]')).toBeDefined()
    expect(bySelector('input[name="remember"]')).toBeDefined()
  })

  it('classifies element kinds', () => {
    expect(bySelector("getByTestId('email-input')")!.kind).toBe('input')
    expect(bySelector("getByRole('button', { name: 'Log in' })")!.kind).toBe('button')
    expect(bySelector('input[name="remember"]')!.kind).toBe('checkbox')
    expect(bySelector('select[name="locale"]')!.kind).toBe('select')
  })

  it('skips non-interactive elements and dedupes', () => {
    expect(entries.some(e => e.label.includes('not interactive'))).toBe(false)
    const selectors = entries.map(e => e.selector)
    expect(new Set(selectors).size).toBe(selectors.length)
  })

  it('escapes single quotes in labels', () => {
    const html = `<button>It's fine</button>`
    const [entry] = distillHtml(html)
    expect(entry.selector).toBe("page.getByRole('button', { name: 'It\\'s fine' })")
  })
})

describe('label association', () => {
  it('uses <label for> association even without aria-label/placeholder', () => {
    const html = `<label for="uname">Username</label><input id="uname" type="text" />`
    const [entry] = distillHtml(html)
    expect(entry.selector).toBe("page.getByLabel('Username')")
    expect(entry.label).toBe('Username')
  })

  it('uses an implicit wrapping <label> when the input has no for/aria/placeholder', () => {
    const html = `<label>Accept terms <input id="terms" type="checkbox" /></label>`
    const [entry] = distillHtml(html)
    expect(entry.selector).toBe("page.getByLabel('Accept terms')")
  })

  it('prefers data-testid over a label association', () => {
    const html = `<label for="uname">Username</label><input id="uname" data-testid="username-field" type="text" />`
    const [entry] = distillHtml(html)
    expect(entry.selector).toBe("page.getByTestId('username-field')")
  })
})

describe('broader interactive element detection', () => {
  it('detects role=switch, role=menuitem, and summary/contenteditable', () => {
    const html = `
      <div role="switch" aria-label="Dark mode">toggle</div>
      <div role="menuitem">Settings</div>
      <summary>Show more</summary>
      <div contenteditable="true" aria-label="Notes">notes</div>
    `
    const entries = distillHtml(html)
    expect(entries.find(e => e.label === 'Dark mode')?.kind).toBe('checkbox')
    expect(entries.some(e => e.label === 'Settings')).toBe(true)
    expect(entries.some(e => e.label === 'Show more')).toBe(true)
    expect(entries.find(e => e.label === 'Notes')?.kind).toBe('textarea')
  })
})

describe('page tagging', () => {
  it('tags every distilled element with the provided page name', () => {
    const entries = distillHtml(`<button>Save</button>`, 'Settings')
    expect(entries[0].page).toBe('Settings')
  })
})

describe('hidden/disabled element filtering', () => {
  it('excludes hidden inputs, [hidden], aria-hidden, and inline-hidden elements', () => {
    const html = `
      <input type="hidden" name="csrf" value="abc" />
      <button hidden>Ghost</button>
      <button aria-hidden="true">Also hidden</button>
      <button style="display: none;">Invisible</button>
      <button style="visibility:hidden">Also invisible</button>
      <button>Visible Save</button>
    `
    const entries = distillHtml(html)
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe('Visible Save')
  })

  it('excludes disabled controls', () => {
    const html = `
      <button disabled>Submit</button>
      <input aria-disabled="true" placeholder="Locked field" />
      <button>Active Button</button>
    `
    const entries = distillHtml(html)
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe('Active Button')
  })
})

describe('duplicate label disambiguation', () => {
  it('keeps every occurrence of a repeated label, disambiguated with .nth() instead of dropping duplicates', () => {
    const html = `
      <table>
        <tr><td>Row 1</td><td><button>Edit</button></td></tr>
        <tr><td>Row 2</td><td><button>Edit</button></td></tr>
        <tr><td>Row 3</td><td><button>Edit</button></td></tr>
      </table>
    `
    const entries = distillHtml(html)
    expect(entries).toHaveLength(3)
    const selectors = entries.map(e => e.selector)
    expect(new Set(selectors).size).toBe(3) // all unique, none silently dropped
    expect(selectors[0]).toBe("page.getByRole('button', { name: 'Edit' })")
    expect(selectors[1]).toBe("page.getByRole('button', { name: 'Edit' }).nth(1)")
    expect(selectors[2]).toBe("page.getByRole('button', { name: 'Edit' }).nth(2)")
    // Labels are disambiguated for humans too
    expect(entries.map(e => e.label)).toEqual(['Edit', 'Edit (2)', 'Edit (3)'])
  })

  it('does not disambiguate elements whose selectors are genuinely unique (id/testid based)', () => {
    const html = `
      <button data-testid="save-1">Save</button>
      <button data-testid="save-2">Save</button>
    `
    const entries = distillHtml(html)
    expect(entries.map(e => e.selector)).toEqual([
      "page.getByTestId('save-1')",
      "page.getByTestId('save-2')"
    ])
    // No .nth() needed since testids already make them unique
    expect(entries.every(e => !e.selector.includes('.nth('))).toBe(true)
  })
})

describe('mergeElements', () => {
  const a = { selector: "page.getByTestId('email')", tag: 'input', label: 'Email', kind: 'input' as const }
  const b = { selector: "page.getByRole('button', { name: 'Submit' })", tag: 'button', label: 'Submit', kind: 'button' as const }

  it('accumulates elements from multiple sources instead of replacing', () => {
    const merged = mergeElements([a], [b])
    expect(merged).toEqual([a, b])
  })

  it('deduplicates by selector, letting the later source win', () => {
    const bUpdated = { ...b, label: 'Submit (updated)' }
    const merged = mergeElements([a, b], [bUpdated])
    expect(merged).toHaveLength(2)
    expect(merged.find(e => e.selector === b.selector)?.label).toBe('Submit (updated)')
  })

  it('handles empty inputs', () => {
    expect(mergeElements([], [a])).toEqual([a])
    expect(mergeElements([a], [])).toEqual([a])
  })
})

describe('ARIA role inference (an <a> without href has no implicit role)', () => {
  it('does not emit getByRole for an anchor with no href', () => {
    // Real defect: <a class="addItem">Add to Basket</a> was targeted with
    // getByRole('button'|'link', ...) which matches ZERO elements at runtime,
    // because an anchor without href is exposed with no role at all.
    const html = `<html><body>
      <a class="addItem" onclick="add()">Add to Basket</a>
    </body></html>`
    const els = distillHtml(html)
    const addItem = els.find(e => e.label === 'Add to Basket')
    expect(addItem).toBeDefined()
    expect(addItem!.kind).not.toBe('link')
    expect(addItem!.selector).not.toContain("getByRole('link'")
    expect(addItem!.selector).not.toContain("getByRole('button'")
  })

  it('still treats a real anchor (with href) as a link', () => {
    const els = distillHtml(`<html><body><a href="/sweets">Sweets</a></body></html>`)
    const link = els.find(e => e.label === 'Sweets')
    expect(link!.kind).toBe('link')
  })

  it('honours an explicit role=link even without href', () => {
    const els = distillHtml(`<html><body><a role="link" onclick="go()">Go</a></body></html>`)
    expect(els.find(e => e.label === 'Go')!.kind).toBe('link')
  })
})

describe('locator robustness fixes', () => {
  it('uses a regex accessible-name when the label leads with a live counter', () => {
    // Real defect: getByRole('link', { name: '0 Basket' }) breaks the moment
    // the first item is added and the badge reads "1 Basket".
    const els = distillHtml(`<html><body><a href="/basket">0 Basket</a></body></html>`)
    const basket = els.find(e => e.kind === 'link')!
    expect(basket.selector).toContain('name: /Basket/')
    expect(basket.selector).not.toContain("'0 Basket'")
  })

  // An accessible name is computed from the WHOLE subtree, so descendant text
  // must be included. Trimming to the element's own text would break every
  // getByRole(..., { name }) we emit.
  it('derives the accessible name from descendant text', () => {
    const els = distillHtml(`<html><body><button><span>Login</span></button></body></html>`)
    expect(els.find(e => e.kind === 'button')!.label).toBe('Login')
  })
})

describe('locator fallback tiers below ARIA role', () => {
  it('grounds an href-less anchor via its data-* hook (the .addItem case)', () => {
    // Real defect: <a class="addItem" data-name="Bon Bons"> was never grounded,
    // because extraction only matched a[href] and had no data-*/class tier.
    const els = distillHtml(`<html><body>
      <a class="addItem" data-name="Bon Bons">Add to Basket</a>
    </body></html>`)
    const add = els.find(e => e.label === 'Add to Basket')
    expect(add).toBeDefined()
    expect(add!.selector).toContain('[data-name="Bon Bons"]')
  })

  it('falls back to a stable class, ignoring utility classes', () => {
    const els = distillHtml(`<html><body>
      <a class="btn col-md-4 addItem"></a>
    </body></html>`)
    const el = els[0]
    expect(el.selector).toContain('a.addItem')
    expect(el.selector).not.toContain('btn')
    expect(el.selector).not.toContain('col-md-4')
  })

  it('still prefers role+name over data-* when a name exists', () => {
    const els = distillHtml(`<html><body><button data-id="7">Save</button></body></html>`)
    expect(els[0].selector).toContain("getByRole('button', { name: 'Save' })")
  })
})

describe('detectCollections (repeating structures)', () => {
  // Shaped like the real sweetshop product grid that was never grounded.
  const GRID = `<html><body><div class="row">
    ${[1, 2, 3, 4].map(i => `
      <div class="col-md-4">
        <div class="card">
          <div class="card-body">
            <h4 class="card-title">Sweet ${i}</h4>
            <p class="card-text">Description ${i}</p>
            <p><small class="text-muted">£0.7${i}</small></p>
          </div>
          <div class="card-footer">
            <a class="btn btn-success addItem" data-name="Sweet ${i}">Add to Basket</a>
          </div>
        </div>
      </div>`).join('')}
  </div></body></html>`

  it('grounds the card grid as a set locator with per-item fields', () => {
    const [cards] = detectCollections(GRID)
    expect(cards.itemSelector).toBe('.card')
    expect(cards.count).toBe(4)
    const selectors = cards.fields.map(f => f.selector)
    expect(selectors).toContain('.card-title')
    expect(selectors).toContain('.card-text')
    expect(selectors).toContain('.addItem')
  })

  it('never emits an index-based selector (list order is randomised at runtime)', () => {
    for (const c of detectCollections(GRID)) {
      expect(c.itemSelector).not.toContain('nth')
      expect(c.itemSelector).not.toMatch(/:\s*\d+/)
    }
  })

  it('ignores utility-class wrappers like col-md-4', () => {
    const found = detectCollections(GRID).map(c => c.itemSelector)
    expect(found).not.toContain('.col-md-4')
  })

  it('requires at least 3 repeats and a common ancestor', () => {
    const twoOnly = `<div><div class="card"><h4>a</h4></div><div class="card"><h4>b</h4></div></div>`
    expect(detectCollections(twoOnly)).toHaveLength(0)
  })

  it('tags collections with the page name', () => {
    expect(detectCollections(GRID, 'Home')[0].page).toBe('Home')
  })
})

describe('mergeCollections', () => {
  const a = { name: 'card', itemSelector: '.card', count: 4, fields: [], page: 'Home' }
  it('dedupes by page + itemSelector, later wins', () => {
    const merged = mergeCollections([a], [{ ...a, count: 9 }])
    expect(merged).toHaveLength(1)
    expect(merged[0].count).toBe(9)
  })
})

describe('detectCollections — real sweetshop markup regressions', () => {
  // Verbatim shape from https://sweetshop.vivrichards.co.uk/
  const REAL = `<html><body><div class="row">
    ${[1, 2, 3, 4].map(i => `
      <div class="col-lg-3 col-md-6 mb-4 cards">
        <div class="card">
          <img class="card-img-top" src="x.png">
          <div class="card-body">
            <h4 class="card-title">Sweet ${i}</h4>
            <p class="card-text">Desc ${i}</p>
          </div>
          <div class="card-footer">
            <a class="addItem" data-id="${i}" data-name="Sweet ${i}">Add to Basket</a>
          </div>
        </div>
      </div>`).join('')}
  </div></body></html>`

  it('keeps the real item (.card) and drops the layout wrapper (.cards)', () => {
    // Both repeat 4x, but .cards merely CONTAINS .card — emitting both is noise.
    const selectors = detectCollections(REAL).map(c => c.itemSelector)
    expect(selectors).toContain('.card')
    expect(selectors).not.toContain('.cards')
  })

  it('preserves camelCase in field names (.addItem -> addItem, not additem)', () => {
    const card = detectCollections(REAL).find(c => c.itemSelector === '.card')!
    const names = card.fields.map(f => f.name)
    expect(names).toContain('addItem')
    expect(names).toContain('cardTitle')
    expect(names).not.toContain('additem')
  })
})

describe('detectCollections — grid split across multiple row containers', () => {
  // The real /sweets page: 16 cards across 4 <div class="row">, each card in an
  // identical utility-class wrapper (no shared parent OR grandparent).
  const rows = [0, 1, 2, 3].map(r => `
    <div class="row">
      ${[0, 1, 2, 3].map(i => `
        <div class="col-lg-3 col-md-6 mb-4">
          <div class="card">
            <div class="card-body">
              <h4 class="card-title">Sweet ${r * 4 + i}</h4>
              <p class="card-text">Desc</p>
            </div>
            <div class="card-footer">
              <a class="addItem" data-id="${r * 4 + i}">Add to Basket</a>
            </div>
          </div>
        </div>`).join('')}
    </div>`).join('')
  const MULTI_ROW = `<html><body>${rows}</body></html>`

  it('grounds the grid even when items share no common parent or grandparent', () => {
    const selectors = detectCollections(MULTI_ROW).map(c => c.itemSelector)
    expect(selectors).toContain('.card')
  })

  it('reports the full item count across all rows', () => {
    const card = detectCollections(MULTI_ROW).find(c => c.itemSelector === '.card')!
    expect(card.count).toBe(16)
    expect(card.fields.map(f => f.selector)).toContain('.addItem')
  })

  it('does not emit sub-parts (.card-body/.card-title) as their own collections', () => {
    const selectors = detectCollections(MULTI_ROW).map(c => c.itemSelector)
    expect(selectors).not.toContain('.card-body')
    expect(selectors).not.toContain('.card-title')
  })
})

describe('detectCollections — interactive item action with only utility classes', () => {
  // books.toscrape.com: the "Add to basket" button's classes are `btn btn-primary`
  // (pure utility), so a class/data-only field scan drops the item's whole point.
  const GRID = `<html><body><section>${[1, 2, 3].map(i => `
    <article class="product_pod">
      <h3><a href="/b${i}">Book ${i}</a></h3>
      <p class="price_color">£${i}.00</p>
      <button class="btn btn-primary" type="submit">Add to basket</button>
    </article>`).join('')}</section></body></html>`

  it('captures the item action by tag when it has no stable class', () => {
    const pod = detectCollections(GRID).find(c => c.itemSelector === '.product_pod')!
    expect(pod.fields.map(f => f.selector)).toContain('button')
  })

  it('still prefers a stable class over the bare tag', () => {
    const withClass = GRID.replace(/class="btn btn-primary"/g, 'class="btn addItem"')
    const pod = detectCollections(withClass).find(c => c.itemSelector === '.product_pod')!
    expect(pod.fields.map(f => f.selector)).toContain('.addItem')
    expect(pod.fields.map(f => f.selector)).not.toContain('button')
  })
})

describe('detectCollections — classless <tr>/<li> rows (real the-internet.herokuapp.com/tables markup)', () => {
  const TABLES_PAGE = `<html><body>
    <table id="table1" class="tablesorter">
      <thead><tr><th><span>Last Name</span></th><th><span>First Name</span></th><th><span>Email</span></th><th><span>Due</span></th><th><span>Web Site</span></th><th><span>Action</span></th></tr></thead>
      <tbody>
        ${['Smith', 'Bach', 'Doe', 'Conway'].map(n => `
        <tr>
          <td>${n}</td><td>First</td><td>${n.toLowerCase()}@x.com</td><td>$50.00</td><td>http://x.com</td>
          <td><a href='#edit'>edit</a> <a href='#delete'>delete</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <table id="table2" class="tablesorter">
      <thead><tr><th><span>Last Name</span></th><th><span>First Name</span></th><th><span>Email</span></th><th><span>Due</span></th><th><span>Web Site</span></th><th><span>Action</span></th></tr></thead>
      <tbody>
        ${['Fiona', 'Gamora', 'Hulk'].map(n => `
        <tr>
          <td>${n}</td><td>First</td><td>${n.toLowerCase()}@x.com</td><td>$50.00</td><td>http://x.com</td>
          <td><a href='#edit'>edit</a> <a href='#delete'>delete</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </body></html>`

  it('grounds classless data rows as a collection scoped by the table id', () => {
    // Real gap found live: a page that is LITERALLY two data tables produced
    // ZERO collections, because <tr>/<td> here carry no class anywhere.
    const collections = detectCollections(TABLES_PAGE)
    const table1Rows = collections.find(c => c.itemSelector === '#table1 tbody tr')
    expect(table1Rows).toBeDefined()
    expect(table1Rows!.count).toBe(4)
  })

  it('keeps two same-class tables SEPARATE by preferring id over the shared class', () => {
    // Real bug in my own first attempt: both tables share class="tablesorter",
    // which would have merged all 7 rows into one collection if class were
    // preferred over id.
    const collections = detectCollections(TABLES_PAGE)
    const t1 = collections.find(c => c.itemSelector === '#table1 tbody tr')!
    const t2 = collections.find(c => c.itemSelector === '#table2 tbody tr')!
    expect(t1.count).toBe(4)
    expect(t2.count).toBe(3)
  })

  it('excludes the header row (<thead>) from the data-row collection', () => {
    const collections = detectCollections(TABLES_PAGE)
    const t1 = collections.find(c => c.itemSelector === '#table1 tbody tr')!
    expect(t1.count).toBe(4) // not 5 – the thead row must not count as a data item
  })

  it('addresses classless table cells by position (nth-child)', () => {
    const t1 = detectCollections(TABLES_PAGE).find(c => c.itemSelector === '#table1 tbody tr')!
    expect(t1.fields.map(f => f.selector)).toContain('td:nth-child(1)')
  })
})

describe('detectCollections — classless <li> list items', () => {
  it('grounds a bare <ul><li> list scoped by the list class', () => {
    const html = `<ul class="menu">${['Home', 'About', 'Contact', 'Blog'].map(t => `<li>${t}</li>`).join('')}</ul>`
    const collections = detectCollections(html)
    const menu = collections.find(c => c.itemSelector === '.menu > li')
    expect(menu).toBeDefined()
    expect(menu!.count).toBe(4)
  })
})
