import express from 'express'
import axios from 'axios'
import { completeLimiter } from './middleware.mjs'

const router = express.Router()

const LLM_TIMEOUT_MS = 55_000

const SYSTEM_PROMPT = `You are an expert QA Engineer and Systems Architect.
Analyze the provided requirement summary, description, and visual spec details.
Generate a highly detailed, professional test suite with 3 to 5 custom test cases covering the main functional flows, fields, actions, and validation logic described in the requirement.
For each testcase, write exactly 5 to 8 functional action steps directly testing the core logic.
Each step must contain 'stepNumber' (int), 'action' (string), 'testData' (string), and 'expectedResult' (string).

Output ONLY valid JSON matching this schema exactly:
{
  "testCases": [
    {
      "id": "TC-001",
      "summary": "Verify detailed test case summary matching the requirement",
      "issueType": "Test",
      "priority": "Critical" | "High" | "Medium" | "Low",
      "labels": "functional,happy_path,ui",
      "testType": "Functional" | "Security" | "Performance" | "UI/UX",
      "precondition": "Preconditions for the test run",
      "steps": [
        {
          "stepNumber": 1,
          "action": "Action description step",
          "testData": "Specific test inputs",
          "expectedResult": "Expected verification result"
        }
      ],
      "status": "Not Executed",
      "component": "Feature component name",
      "estimatedTime": "15m",
      "scenarioType": "happy_path" | "boundary" | "security" | "performance" | "ui_ux" | "negative"
    }
  ]
}`

// Server-side fallback generator for users without their own API key.
// Uses the server's Gemini key when configured; otherwise responds 503 and
// the client falls back to its local rules engine (rulesEngine.generate()).
router.post('/api/rules/generate', completeLimiter, async (req, res) => {
  const { summary, description } = req.body || {}
  if (!summary && !description) {
    return res.status(400).json({ error: 'Missing summary/description in request body' })
  }

  const geminiKey = process.env.GEMINI_FREE_API_KEY || process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || process.env.VITE_GEMINI_API_KEY
  if (!geminiKey) {
    return res.status(503).json({ error: 'No server-side generation key configured – use the local rules engine.' })
  }

  try {
    const userPrompt = `Requirement Summary: ${summary}\nRequirement Description:\n${description}`

    const rulesModel = process.env.GEMINI_RULES_MODEL || 'gemini-flash-lite-latest'
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${rulesModel}:generateContent?key=${geminiKey}`,
      {
        contents: [{ parts: [{ text: SYSTEM_PROMPT }, { text: userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      },
      { timeout: LLM_TIMEOUT_MS }
    )

    const contentText = response.data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!contentText) {
      return res.status(502).json({ error: 'Generation service returned an empty response.' })
    }

    const parsed = JSON.parse(contentText)
    if (!parsed || !Array.isArray(parsed.testCases) || parsed.testCases.length === 0) {
      return res.status(502).json({ error: 'Generation service returned no test cases.' })
    }

    for (const tc of parsed.testCases) {
      tc.status = 'Not Executed'
      if (!tc.estimatedTime) tc.estimatedTime = '20m'
      if (!tc.issueType) tc.issueType = 'Test'
      if (Array.isArray(tc.steps)) {
        tc.steps.forEach((step, i) => { step.stepNumber = i + 1 })
      }
    }

    console.log(`Server-side Gemini generation successful. Returning ${parsed.testCases.length} cases.`)
    res.json(parsed)
  } catch (error) {
    console.warn('Server-side Gemini generation failed:', error.message)
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Generation service rate limited – try again later.' })
    }
    res.status(502).json({ error: `Server-side generation failed: ${error.message}` })
  }
})

export default router
