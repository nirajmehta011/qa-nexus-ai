import express from 'express'
import axios from 'axios'
import dns from 'dns/promises'
import net from 'net'

const router = express.Router()

// ─────────────────────────────── HEALTH ──────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'Backend proxy server running', version: '2.1.0' })
})

// ─────────────────────────────── FETCH URL ───────────────────────────────────
export function isPrivateIP(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    const v4Mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4Mapped) return isPrivateIPv4(v4Mapped[1])
    return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
  }
  return isPrivateIPv4(ip)
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true
  const [a, b] = parts
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local / cloud metadata
    a >= 224 // multicast + reserved
  )
}

// Throws unless the URL is http(s) and resolves to a public address.
export async function assertPublicHttpUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const ip = net.isIP(host) ? host : (await dns.lookup(host)).address
  if (isPrivateIP(ip)) {
    throw new Error('URL resolves to a private or internal address')
  }
  return parsed
}

const MAX_REDIRECTS = 3

router.post('/api/fetch-url', async (req, res) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ error: 'Missing URL parameter' })

    // Follow redirects manually so every hop is re-validated against SSRF.
    let currentUrl = url
    let response = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttpUrl(currentUrl)
      response = await axios.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: s => (s >= 200 && s < 300) || (s >= 300 && s < 400)
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location
        if (!location || hop === MAX_REDIRECTS) throw new Error('Too many redirects')
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      break
    }
    res.json({ success: true, html: response.data })
  } catch (error) {
    if (/private or internal|Only http|Invalid URL/.test(error.message || '')) {
      return res.status(400).json({ error: error.message })
    }
    const msg = error.response?.data || error.message || 'Failed to fetch website URL'
    res.status(500).json({ error: msg })
  }
})

// ─────────────────────────── CHECK URL (route existence) ─────────────────────
// Returns the upstream HTTP status so the automation generator can reject
// guessed routes before emitting page.goto(). Unlike /api/fetch-url this never
// throws on 4xx/5xx – the status IS the answer. status:0 means unreachable/DNS.
router.post('/api/check-url', async (req, res) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ error: 'Missing URL parameter' })

    let currentUrl = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttpUrl(currentUrl)
      const response = await axios.get(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QANexus-RouteCheck/1.0)' },
        timeout: 10000,
        maxRedirects: 0,
        validateStatus: () => true
      })
      if (response.status >= 300 && response.status < 400 && response.headers.location && hop < MAX_REDIRECTS) {
        currentUrl = new URL(response.headers.location, currentUrl).toString()
        continue
      }
      return res.json({ success: true, status: response.status })
    }
    return res.json({ success: true, status: 0 })
  } catch (error) {
    if (/private or internal|Only http|Invalid URL/.test(error.message || '')) {
      return res.status(400).json({ error: error.message })
    }
    // DNS failure / connection refused – the route is unreachable, not a server bug.
    res.json({ success: true, status: 0 })
  }
})

// ─────────────────────────────── JIRA ────────────────────────────────────────
router.post('/api/jira/test', async (req, res) => {
  try {
    const { email, token, baseUrl } = req.body
    if (!email || !token || !baseUrl) return res.status(400).json({ error: 'Missing Jira credentials' })

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    const response = await axios.get(`${baseUrl}/rest/api/3/myself`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout: 10000
    })
    res.json({ success: true, user: response.data })
  } catch (error) {
    const e = error
    if (e.response?.status === 401) return res.status(401).json({ error: 'Jira authentication failed – check email/token' })
    if (e.response?.status === 404) return res.status(404).json({ error: 'Jira URL not found – check base URL' })
    if (e.code === 'ENOTFOUND') return res.status(400).json({ error: 'Invalid Jira URL – host not found' })
    res.status(500).json({ error: e.message || 'Unknown error' })
  }
})

router.post('/api/jira/issue', async (req, res) => {
  try {
    const { email, token, baseUrl, issueKey } = req.body
    if (!email || !token || !baseUrl || !issueKey) return res.status(400).json({ error: 'Missing required parameters' })

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    // Fix: correct Jira API path is /rest/api/3/issue/ (not /issues/)
    const response = await axios.get(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout: 10000
    })
    res.json({ success: true, issue: response.data })
  } catch (error) {
    const e = error
    if (e.response?.status === 401) return res.status(401).json({ error: 'Jira authentication failed' })
    if (e.response?.status === 404) return res.status(404).json({ error: `Issue not found. Check the Issue Key.` })
    res.status(500).json({ error: e.message || 'Unknown error' })
  }
})

// Project metadata for issue creation: available issue types + required fields
router.post('/api/jira/createmeta', async (req, res) => {
  try {
    const { email, token, baseUrl, projectKey } = req.body
    if (!email || !token || !baseUrl || !projectKey) return res.status(400).json({ error: 'Missing required parameters' })

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    const headers = { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }

    const typesResp = await axios.get(
      `${baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      { headers, timeout: 15000 }
    )
    const issueTypes = []
    for (const it of (typesResp.data.issueTypes || typesResp.data.values || [])) {
      let requiredFields = []
      try {
        const fieldsResp = await axios.get(
          `${baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${it.id}`,
          { headers, timeout: 15000 }
        )
        requiredFields = (fieldsResp.data.fields || fieldsResp.data.values || [])
          .filter(f => f.required && !['project', 'issuetype', 'summary', 'reporter'].includes(f.key || f.fieldId))
          .map(f => ({ key: f.key || f.fieldId, name: f.name }))
      } catch {
        // Field metadata is best-effort – older instances may not support this endpoint
      }
      issueTypes.push({ id: it.id, name: it.name, subtask: !!it.subtask, requiredFields })
    }
    res.json({ success: true, issueTypes })
  } catch (error) {
    const e = error
    if (e.response?.status === 401) return res.status(401).json({ error: 'Jira authentication failed' })
    if (e.response?.status === 404) return res.status(404).json({ error: `Project not found or no create permission. Check the project key.` })
    res.status(500).json({ error: e.response?.data?.errorMessages?.join('; ') || e.message || 'Unknown error' })
  }
})

// Issue summaries for duplicate detection before pushing generated cases
router.post('/api/jira/search', async (req, res) => {
  try {
    const { email, token, baseUrl, jql, maxResults } = req.body
    if (!email || !token || !baseUrl || !jql) return res.status(400).json({ error: 'Missing required parameters' })

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    const response = await axios.post(
      `${baseUrl}/rest/api/3/search/jql`,
      { jql, fields: ['summary'], maxResults: Math.min(Number(maxResults) || 100, 200) },
      { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    )
    const issues = (response.data.issues || []).map(i => ({ key: i.key, summary: i.fields?.summary || '' }))
    res.json({ success: true, issues })
  } catch (error) {
    const e = error
    if (e.response?.status === 401) return res.status(401).json({ error: 'Jira authentication failed' })
    if (e.response?.status === 400) return res.status(400).json({ error: e.response?.data?.errorMessages?.join('; ') || 'Invalid JQL query' })
    res.status(500).json({ error: e.response?.data?.errorMessages?.join('; ') || e.message || 'Unknown error' })
  }
})

// Create one issue (client pushes sequentially for per-case error reporting)
router.post('/api/jira/create-issue', async (req, res) => {
  try {
    const { email, token, baseUrl, payload } = req.body
    if (!email || !token || !baseUrl || !payload?.fields) return res.status(400).json({ error: 'Missing required parameters' })

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    const response = await axios.post(
      `${baseUrl}/rest/api/3/issue`,
      payload,
      { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    )
    res.json({ success: true, key: response.data.key, id: response.data.id })
  } catch (error) {
    const e = error
    if (e.response?.status === 401) return res.status(401).json({ error: 'Jira authentication failed' })
    const jiraErrors = e.response?.data?.errors
      ? Object.entries(e.response.data.errors).map(([field, msg]) => `${field}: ${msg}`).join('; ')
      : null
    res.status(e.response?.status || 500).json({
      error: jiraErrors || e.response?.data?.errorMessages?.join('; ') || e.message || 'Failed to create issue'
    })
  }
})

// ─────────────────────────────── FIGMA ───────────────────────────────────────
router.post('/api/figma/fetch', async (req, res) => {
  try {
    const { fileUrl, accessToken } = req.body
    if (!fileUrl) return res.status(400).json({ error: 'Missing Figma URL' })
    if (!accessToken) return res.status(400).json({ error: 'Missing Figma Personal Access Token' })

    const match = fileUrl.match(/(?:file|design)\/([a-zA-Z0-9]{22,128})/)
    if (!match) {
      return res.status(400).json({ error: 'Invalid Figma URL format' })
    }
    const fileKey = match[1]

    const urlObj = new URL(fileUrl)
    const nodeId = urlObj.searchParams.get('node-id')

    let apiUrl = `https://api.figma.com/v1/files/${fileKey}`
    if (nodeId) {
      apiUrl += `?ids=${nodeId}`
    }

    const fileResponse = await axios.get(apiUrl, {
      headers: { 'X-Figma-Token': accessToken },
      timeout: 15000
    })

    let ids = nodeId
    if (!ids) {
      const frames = []
      const walk = (node) => {
        if (node.type === 'FRAME' || node.type === 'CANVAS' || node.type === 'COMPONENT') {
          frames.push(node.id)
        }
        if (node.children) {
          node.children.forEach(walk)
        }
      }
      if (fileResponse.data.document) walk(fileResponse.data.document)
      ids = frames.slice(0, 5).join(',')
    }

    if (!ids) {
      return res.status(400).json({ error: 'No frames or components found in the Figma file' })
    }

    const imagesResponse = await axios.get(`https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=png`, {
      headers: { 'X-Figma-Token': accessToken },
      timeout: 15000
    })

    const imageUrls = imagesResponse.data.images || {}
    const exportedImages = []

    for (const [id, url] of Object.entries(imageUrls)) {
      if (url) {
        const imgResp = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 })
        const base64 = Buffer.from(imgResp.data).toString('base64')
        exportedImages.push({
          nodeId: id,
          mimeType: 'image/png',
          base64: base64
        })
      }
    }

    res.json({
      success: true,
      fileName: fileResponse.data.name,
      images: exportedImages,
      nodeId: nodeId
    })
  } catch (error) {
    console.error('Figma fetch error:', error.message)
    const status = error.response?.status || 500
    const msg = error.response?.data?.err || error.response?.data?.message || error.message || 'Failed to fetch Figma file'
    res.status(status).json({ error: msg })
  }
})

export default router
