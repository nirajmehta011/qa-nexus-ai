import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Vitest runs without globals, so RTL's automatic per-test cleanup never
// registers — without this, each render stacks onto the previous document.
afterEach(cleanup)

// jsdom implements neither of these, and both are hit by the components under
// test (file downloads and video thumbnails).
if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:mock'
  URL.revokeObjectURL = () => {}
}
