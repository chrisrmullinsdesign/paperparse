/**
 * Printed-grid geometry, derived from a FormSpec.
 *
 * Given a row key, answer "where on the photograph is that row?" — in normalized
 * coordinates, so the same answer works for a 12MP phone photo and a 600px thumbnail.
 *
 * This is what makes section-by-section extraction possible: instead of asking the
 * model to read a 100-row grid in one pass (where it reliably summarizes rather than
 * transcribes), crop to ten rows at a time and ask for those.
 */

import type { FormSpec, KeyRange, LayoutBlock, NormRect } from './types.js'

const DEFAULT_ROW_PAD_FRACTION = 0.1
const DEFAULT_SECTION_CHUNK_ROWS = 10

function inRange(key: number, r: KeyRange): boolean {
  return key >= r.from && key <= r.to
}

/** The first block that claims this key, or null. Declaration order is precedence. */
export function blockForKey(spec: FormSpec, key: number): LayoutBlock | null {
  if (!Number.isFinite(key)) return null
  for (const block of spec.layout.blocks) {
    if (inRange(key, block.keys)) return block
  }
  return null
}

/** Height of one printed row within a block, as a fraction of image height. */
export function rowPitch(block: LayoutBlock): number {
  return (block.y[1] - block.y[0]) / block.rowSlots
}

/**
 * Normalized rect covering one row's printed extent, padded vertically so
 * overflowing handwriting survives the crop.
 */
export function rectForKey(spec: FormSpec, key: number): NormRect | null {
  const block = blockForKey(spec, key)
  if (!block) return null

  const slot = key - block.keys.from + (block.slotOffset ?? 0)
  const pitch = rowPitch(block)
  const pad = pitch * (spec.layout.rowPadFraction ?? DEFAULT_ROW_PAD_FRACTION)

  const top = Math.max(0, block.y[0] + slot * pitch - pad)
  const bottom = Math.min(1, block.y[0] + (slot + 1) * pitch + pad)

  return {
    x: block.x[0],
    y: top,
    w: block.x[1] - block.x[0],
    h: Math.max(0, bottom - top),
  }
}

/** Bounding rect covering every listed key. Used to crop a whole section at once. */
export function rectForKeys(spec: FormSpec, keys: readonly number[]): NormRect | null {
  const rects = [...new Set(keys)]
    .map((k) => rectForKey(spec, k))
    .filter((r): r is NormRect => r !== null)
  if (rects.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: Math.max(0.02, maxX - minX), h: Math.max(0.02, maxY - minY) }
}

/**
 * Grow a rect vertically by whole rows. Horizontal extent is untouched — printed
 * columns must stay aligned or the crop starts including a neighbouring column.
 *
 * A row or two of overlap between adjacent section crops costs very little and
 * prevents a row that straddles a crop boundary from being lost by both passes.
 */
export function expandByRows(rect: NormRect, rows: number, pitch: number): NormRect {
  if (!Number.isFinite(rows) || rows <= 0) return rect
  if (!Number.isFinite(pitch) || pitch <= 0) return rect
  const dy = rows * pitch
  const top = Math.max(0, rect.y - dy)
  const bottom = Math.min(1, rect.y + rect.h + dy)
  return { x: rect.x, y: top, w: rect.w, h: Math.max(0.02, bottom - top) }
}

/** Representative row pitch for a set of keys — the pitch of the block they sit in. */
export function pitchForKeys(spec: FormSpec, keys: readonly number[]): number {
  const first = keys.find((k) => blockForKey(spec, k) !== null)
  const block = first === undefined ? null : blockForKey(spec, first)
  if (block) return rowPitch(block)
  const fallback = spec.layout.blocks[0]
  return fallback ? rowPitch(fallback) : 0.02
}

/**
 * Split the form into section chunks for sequential extraction passes.
 *
 * Two rules, and both matter:
 *
 *  1. **Chunks never cross a block boundary.** Each crop then contains exactly one
 *     physical band of the form, so the model is never asked to reconcile rows from
 *     two visually unrelated regions of the page.
 *  2. **Keys claimed by an earlier block are skipped.** A column declared as keys
 *     51–100 whose 90–98 range is claimed by a highlighted band contributes
 *     51–89 and 99–100, and the band contributes 90–98 as its own chunk.
 *
 * Those two rules together reproduce, by derivation, the chunk boundaries that were
 * originally hand-tuned against a real form — which is the argument for the
 * abstraction: the layout is data, and the chunking follows from it.
 */
export function sectionChunks(spec: FormSpec): number[][] {
  const chunkRows = spec.layout.sectionChunkRows ?? DEFAULT_SECTION_CHUNK_ROWS
  const chunks: number[][] = []

  for (const block of spec.layout.blocks) {
    // Keys this block actually resolves — an earlier block may have claimed some.
    const owned: number[] = []
    for (let k = block.keys.from; k <= block.keys.to; k++) {
      if (blockForKey(spec, k)?.id === block.id) owned.push(k)
    }

    // Split into runs of consecutive keys, then chunk each run.
    let run: number[] = []
    const flushRun = () => {
      for (let i = 0; i < run.length; i += chunkRows) {
        chunks.push(run.slice(i, i + chunkRows))
      }
      run = []
    }
    for (const k of owned) {
      if (run.length > 0 && k !== run[run.length - 1] + 1) flushRun()
      run.push(k)
    }
    flushRun()
  }

  return chunks
}

/** Every row key the spec declares as valid, across all ranges. */
export function allValidKeys(spec: FormSpec): number[] {
  const keys: number[] = []
  for (const r of spec.rowKey.ranges) {
    for (let k = r.from; k <= r.to; k++) keys.push(k)
  }
  return keys
}

export function isValidRowKey(spec: FormSpec, key: number): boolean {
  return Number.isFinite(key) && spec.rowKey.ranges.some((r) => inRange(key, r))
}

/** Which block, if any, contains a normalized point. Declaration order applies. */
export function blockAtPoint(spec: FormSpec, x: number, y: number): LayoutBlock | null {
  for (const block of spec.layout.blocks) {
    if (x < block.x[0] || x > block.x[1]) continue
    if (y < block.y[0] || y > block.y[1]) continue
    // The point is inside the block's box, but the slot it lands in may belong to a
    // block declared earlier — a band overlaying a column owns its rows.
    const slot = Math.floor((y - block.y[0]) / rowPitch(block))
    const key = block.keys.from + slot - (block.slotOffset ?? 0)
    if (!inRange(key, block.keys)) continue
    if (blockForKey(spec, key)?.id !== block.id) continue
    return block
  }
  return null
}

/**
 * Inverse of `rectForKey`: which row does this point on the page fall in?
 *
 * The forward direction serves cropping; this one serves any backend that returns
 * words with bounding boxes and leaves you to work out what they mean. Same layout
 * declaration, read the other way.
 */
export function keyAtNormPoint(spec: FormSpec, x: number, y: number): number | null {
  const block = blockAtPoint(spec, x, y)
  if (!block) return null
  const slot = Math.floor((y - block.y[0]) / rowPitch(block))
  const key = block.keys.from + slot - (block.slotOffset ?? 0)
  return inRange(key, block.keys) ? key : null
}

/**
 * Which field's column contains this point, given the block it sits in.
 *
 * Returns null for points in the row-number gutter or any gap between declared
 * columns — those are printed furniture, not data.
 */
export function fieldAtNormPoint(spec: FormSpec, x: number, y: number): string | null {
  const block = blockAtPoint(spec, x, y)
  if (!block) return null
  const width = block.x[1] - block.x[0]
  if (width <= 0) return null
  const rel = (x - block.x[0]) / width

  for (const field of spec.fields) {
    if (!field.column) continue
    if (rel >= field.column[0] && rel < field.column[1]) return field.name
  }
  return null
}
