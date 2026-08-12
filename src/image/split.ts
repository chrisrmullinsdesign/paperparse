/**
 * Vertical splitting for tall two-column forms.
 *
 * The failure this exists to fix: given a photograph of a dense grid, a vision model
 * will often *summarize* it — returning a plausible subset of rows and a confident
 * note — rather than transcribing every line. Halving the information density per
 * request makes it transcribe instead.
 *
 * This is a cheaper, coarser version of the same idea as section cropping
 * (`extract/sections.ts`): fewer requests, no FormSpec geometry needed, and it works
 * on any portrait two-column layout. Reach for sections when accuracy matters more
 * than request count.
 */

import sharp from 'sharp'
import type { Confidence, ExtractionResult, RawRow } from '../types.js'

/** Minimum height/width ratio to attempt a split. A 3:4 phone photo is ~1.333. */
const MIN_PORTRAIT_RATIO = 1.28

/**
 * Horizontal overlap as a fraction of width, applied to both halves.
 *
 * Without it, a form whose centre fold sits slightly off the midpoint loses the
 * inner edge of one column — usually the row-number digits, which are the one
 * field you cannot reconstruct from context.
 */
const OVERLAP_FRACTION = 0.06

export interface SplitHalves {
  left: Buffer
  right: Buffer
}

/** Split a portrait image into overlapping halves. Returns null if not portrait enough. */
export async function splitVertically(input: Buffer): Promise<SplitHalves | null> {
  const meta = await sharp(input).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (!w || !h) return null
  if (h / w < MIN_PORTRAIT_RATIO) return null

  const overlap = Math.round(w * OVERLAP_FRACTION)
  const halfW = Math.round(w / 2)

  const [left, right] = await Promise.all([
    sharp(input)
      .extract({ left: 0, top: 0, width: halfW + overlap, height: h })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer(),
    sharp(input)
      .extract({ left: Math.max(0, halfW - overlap), top: 0, width: w - halfW + overlap, height: h })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer(),
  ])

  return { left, right }
}

function toKey(row: RawRow): number | null {
  const n = typeof row.row_key === 'number' ? row.row_key : parseInt(String(row.row_key), 10)
  return Number.isFinite(n) ? n : null
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

function filledFieldCount(row: RawRow): number {
  return Object.values(row.fields ?? {}).filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== '',
  ).length
}

/**
 * Pick between two readings of the same row.
 *
 * Confidence first, then completeness. Both halves saw the row (that is what the
 * overlap is for), so the question is which read is better, not which is present.
 */
function preferRow(a: RawRow, b: RawRow): RawRow {
  const ca = CONFIDENCE_RANK[a.confidence] ?? 0
  const cb = CONFIDENCE_RANK[b.confidence] ?? 0
  if (ca !== cb) return ca > cb ? a : b
  return filledFieldCount(a) >= filledFieldCount(b) ? a : b
}

function rowsDisagree(a: RawRow, b: RawRow): boolean {
  const keys = new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})])
  for (const k of keys) {
    if (String(a.fields?.[k] ?? '') !== String(b.fields?.[k] ?? '')) return true
  }
  return false
}

/**
 * Merge the two halves' results.
 *
 * Rows appearing in both halves (from the overlap strip) are reconciled by
 * `preferRow`, and every disagreement is recorded in `notes`. Surfacing those
 * explicitly matters: a row the two halves read differently is exactly the row a
 * human reviewer should look at, and silently picking a winner hides that signal.
 */
export function mergeSplitResults(left: ExtractionResult, right: ExtractionResult): ExtractionResult {
  const byKey = new Map<number, RawRow>()
  const seenIn = new Map<number, RawRow[]>()

  for (const row of [...left.rows, ...right.rows]) {
    const key = toKey(row)
    if (key === null) continue
    seenIn.set(key, [...(seenIn.get(key) ?? []), row])
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferRow(existing, row) : row)
  }

  const conflicts: number[] = []
  for (const [key, seen] of seenIn) {
    if (seen.length > 1 && rowsDisagree(seen[0], seen[1])) conflicts.push(key)
  }

  const rows = [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)

  let notes = [left.notes, right.notes].filter(Boolean).join('; right half: ')
  if (conflicts.length > 0) {
    conflicts.sort((a, b) => a - b)
    const shown = conflicts.slice(0, 12).join(', ')
    const more = conflicts.length > 12 ? ` (+${conflicts.length - 12} more)` : ''
    notes = `${notes}; [split-merge: halves disagreed on row(s) ${shown}${more}]`
  }

  return {
    document_date: left.document_date ?? right.document_date,
    rows,
    notes,
    looks_like_expected_form:
      (left.looks_like_expected_form ?? true) || (right.looks_like_expected_form ?? true),
  }
}
