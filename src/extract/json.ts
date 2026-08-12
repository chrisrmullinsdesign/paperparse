/**
 * Recover a JSON object from model output that may be wrapped in prose or fences.
 *
 * With structured outputs (the Anthropic backend below) this is unnecessary — the
 * response is schema-valid by construction. It remains the fallback for backends
 * without schema enforcement, and for the case where a response is truncated at
 * `max_tokens` and you would rather salvage the prefix than discard the request.
 */

/** Returns the JSON text, or null if no parseable object is present. */
export function extractJsonObject(text: string): string | null {
  const fenceStripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()

  try {
    JSON.parse(fenceStripped)
    return fenceStripped
  } catch {
    // Fall through to brace matching.
  }

  // Walk from the first `{` tracking depth, skipping over string literals so a
  // brace inside a transcribed value doesn't terminate the scan early.
  const start = fenceStripped.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < fenceStripped.length; i++) {
    const c = fenceStripped[i]

    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }

    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') depth++
    if (c === '}') {
      depth--
      if (depth === 0) {
        const slice = fenceStripped.slice(start, i + 1)
        try {
          JSON.parse(slice)
          return slice
        } catch {
          return null
        }
      }
    }
  }

  return null
}

export function parseJsonObject<T>(text: string): T | null {
  const json = extractJsonObject(text)
  if (json === null) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
