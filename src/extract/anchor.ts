/**
 * Anchored row resolution — find the rows by reading them, not by computing them.
 *
 * The alternative in this repo, `keyAtNormPoint`, maps a word's coordinates onto
 * hand-authored geometry. That is only valid on a **rectified page**, and a phone
 * photograph of a clipboard is not one. Three things break it, and all three were
 * measured on a corpus of 41 real sheets rather than reasoned about:
 *
 *  1. **Keystone.** The printed gutter drifts ~0.024 in x from the top of the page to
 *     the bottom. Any fixed-x window loses one end of the column.
 *  2. **Pitch is not a constant.** Measured row pitch ranged 0.0096–0.0197 across the
 *     corpus — a 2× spread. No single declared value can serve.
 *  3. **Row keys are not contiguous.** A real roster prints `51, 52, 53, 55, 56, 64,
 *     65…`. Computing `key = first + slot` is not a tuning error, it is the wrong
 *     model of the form, and no coordinate adjustment fixes it.
 *
 * So don't map coordinates to rows. **Anchor on the row number the OCR reads in the
 * printed gutter**, then take the row's cells from the band around that word. That is
 * photo-invariant: it survives skew, off-centre framing, an arbitrary crop, an
 * unexpected resolution, and gaps in the numbering — and it needs no page
 * registration and no declared coordinates at all.
 *
 * Only available because OCR returns boxes. It is the strongest argument for using a
 * geometric backend over a vision model on a form like this.
 *
 * Every rule below exists because something failed without it; the comments say which.
 */

import type { FormSpec, NormRect } from '../formspec/types.js'

/** A recognised word, normalized. `rx` is the right edge — see `findGutters`. */
export interface AnchorWord {
  text: string
  confidence: number
  /** Centre x, centre y, and right edge — all fractions of the page. */
  cx: number
  cy: number
  rx: number
  /**
   * Word height as a fraction of page height.
   *
   * Nothing in the anchoring maths uses it — rows are resolved from `cy` and the
   * fitted pitch. It is carried so a caller can reconstruct the word's box and hand
   * a reviewer the actual pixels, which is the whole reason to prefer a backend
   * that returns coordinates. Optional because the anchoring core is tested against
   * hand-written word lists that have no reason to declare one.
   */
  h?: number
}

/**
 * The word's box, rebuilt from what `AnchorWord` keeps.
 *
 * `cx` is the centre and `rx` the right edge, so the width is twice their gap and
 * the left edge follows. Height falls back to a typical printed line when the word
 * didn't carry one — a slightly wrong box still points at the right cell, which is
 * all a review crop needs.
 */
export function rectOfWord(word: AnchorWord, fallbackHeight = 0.012): NormRect {
  const w = Math.max(0, 2 * (word.rx - word.cx))
  const h = word.h ?? fallbackHeight
  return { x: word.rx - w, y: word.cy - h / 2, w, h }
}

export interface Gutter {
  /** Fitted `rx = a + b·cy`. `b` is the page's keystone, measured from the paper. */
  line: { a: number; b: number }
  anchors: AnchorWord[]
  /** Median spacing between consecutive anchors — this photo's actual row pitch. */
  pitch: number
  /** Fit residual. Tight values (~0.001) mean the column really is a column. */
  rms: number
}

export interface AnchoredRow {
  rowKey: number
  /** Confidence of the printed key itself, not of the row's contents. */
  keyConfidence: number
  cy: number
  /** Cell words in the row's band, ordered left to right. */
  cells: AnchorWord[]
}

export interface AnchorOptions {
  /** Minimum anchors for a column to count as a gutter. */
  minAnchors?: number
  /** How many gutters to expect. A two-column form has two. */
  maxGutters?: number
  /** Row band half-height, as a fraction of fitted pitch. */
  bandFraction?: number
  /**
   * How far right of the gutter a row's cells can sit, in page fractions.
   *
   * Defaults to the widest block the spec declares — see `defaultReach`. Override
   * only for a form whose rows genuinely run past their own block.
   */
  reach?: number
}

const DEFAULTS = { minAnchors: 8, maxGutters: 2, bandFraction: 0.55 }

/**
 * How far a row's cells may sit from its gutter, derived from the form.
 *
 * A row cannot extend past the block that contains it, so the widest declared block
 * is the natural bound — and unlike a constant, it is right for every form rather
 * than for the one it was tuned on.
 *
 * The constant it replaces was 0.34, against blocks 0.47 wide on the worked example.
 * The rightmost column sat at 0.438 and was silently filtered out of every row, so
 * every row lost a required field and the validator dropped all of them. The failure
 * is invisible from inside anchoring: the rows anchor perfectly, they just come back
 * one cell short.
 *
 * Reaching *too far* is the opposite hazard — a two-column form would pull the next
 * column's cells into this row. Block width lands inside the gap between columns,
 * which is why it is the bound rather than a multiple of it.
 */
export function defaultReach(spec: FormSpec): number {
  const widest = Math.max(0, ...spec.layout.blocks.map((b) => b.x[1] - b.x[0]))
  return widest > 0 ? widest : 0.34
}

/** Parse a token as a row key, tolerating a struck-through marker like `/3`. */
export function asRowKey(spec: FormSpec, text: string): { key: number; struck: boolean } | null {
  const m = /^(\/?)(\d{1,4})$/.exec(text.trim())
  if (!m) return null
  const key = Number(m[2])
  const inRange = spec.rowKey.ranges.some((r) => key >= r.from && key <= r.to)
  return inRange ? { key, struck: m[1] === '/' } : null
}

/** Least-squares fit of `rx = a + b·cy`. */
function fitLine(points: readonly AnchorWord[]): { a: number; b: number } {
  const n = points.length
  const sx = points.reduce((s, p) => s + p.cy, 0)
  const sy = points.reduce((s, p) => s + p.rx, 0)
  const sxx = points.reduce((s, p) => s + p.cy * p.cy, 0)
  const sxy = points.reduce((s, p) => s + p.cy * p.rx, 0)
  const denom = n * sxx - sx * sx
  if (denom === 0) return { a: sy / n, b: 0 }
  const b = (n * sxy - sx * sy) / denom
  return { b, a: (sy - b * sx) / n }
}

/**
 * Longest strictly-increasing subsequence of key values, reading down the column.
 *
 * This is the load-bearing trick. A "number of people" column is also a vertical
 * stack of small integers and can outnumber the real gutter on a busy sheet — but its
 * values don't ascend down the page. Selecting on monotonicity rather than token
 * count isolates the printed row index on every sheet format tested, across five
 * years of form revisions, with no layout knowledge at all.
 */
function longestAscending(spec: FormSpec, points: readonly AnchorWord[]): AnchorWord[] {
  const values = points.map((p) => asRowKey(spec, p.text)!.key)
  const best = new Array(values.length).fill(1)
  const from = new Array(values.length).fill(-1)
  let end = 0

  for (let i = 1; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i] && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1
        from[i] = j
      }
    }
    if (best[i] > best[end]) end = i
  }

  const idx: number[] = []
  for (let i = end; i !== -1; i = from[i]) idx.push(i)
  return idx.reverse().map((i) => points[i])
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Locate the printed row-key columns. No declared coordinates, no format knowledge.
 *
 * **Bin on the right edge, not the centre.** The printed column is right-aligned, so
 * `7` and `47` share a right edge but not a centre; binning on centres splits one
 * gutter into two and neither half has enough anchors to survive.
 */
export function findGutters(
  spec: FormSpec,
  words: readonly AnchorWord[],
  opts: AnchorOptions = {},
): Gutter[] {
  const { minAnchors, maxGutters } = { ...DEFAULTS, ...opts }

  const candidates = words.filter((w) => asRowKey(spec, w.text) !== null)
  if (candidates.length < minAnchors) return []

  const bins = new Map<number, AnchorWord[]>()
  for (const w of candidates) {
    const k = Math.round(w.rx / 0.02)
    bins.set(k, [...(bins.get(k) ?? []), w])
  }

  const scored: Array<Gutter & { bin: number }> = []

  for (const k of bins.keys()) {
    // Merge neighbouring bins so a column straddling a boundary isn't halved.
    const merged = [...(bins.get(k - 1) ?? []), ...(bins.get(k) ?? []), ...(bins.get(k + 1) ?? [])]
      .sort((a, b) => a.cy - b.cy)
      .filter((w, i, arr) => i === 0 || Math.abs(w.cy - arr[i - 1].cy) >= 0.004)
    if (merged.length < minAnchors) continue

    const run = longestAscending(spec, merged)
    if (run.length < minAnchors) continue
    // A data column is not mostly ascending; a printed index is.
    if (run.length / merged.length < 0.7) continue

    let keep = run
    let line = fitLine(keep)
    for (let i = 0; i < 5; i++) {
      const res = keep.map((w) => Math.abs(w.rx - (line.a + line.b * w.cy)))
      const med = median(res)
      const next = keep.filter((_, j) => res[j] < Math.max(0.003, med * 3))
      if (next.length < minAnchors) break
      keep = next
      line = fitLine(keep)
    }

    const res = keep.map((w) => Math.abs(w.rx - (line.a + line.b * w.cy)))
    const gaps: number[] = []
    for (let i = 1; i < keep.length; i++) gaps.push(keep[i].cy - keep[i - 1].cy)

    scored.push({
      bin: k,
      line,
      anchors: keep,
      // Median gap, not mean: the numbering has holes, and a single large gap where
      // rows 57-63 are missing would otherwise inflate the pitch for the whole column.
      pitch: median(gaps.filter((g) => g > 0)) || 0.01,
      rms: Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length),
    })
  }

  const out: Gutter[] = []
  for (const s of scored.sort((a, b) => b.anchors.length - a.anchors.length)) {
    if (out.some((o) => Math.abs(fitLine(o.anchors).a - s.line.a) <= 0.02)) continue
    out.push({ line: s.line, anchors: s.anchors, pitch: s.pitch, rms: s.rms })
    if (out.length === maxGutters) break
  }
  return out.sort((a, b) => a.line.a - b.line.a)
}

/**
 * Resolve rows by anchoring on printed keys.
 *
 * Rows with no cell content are returned too, with an empty `cells`. That is
 * deliberate: a review queue seeded only with the parser's positive proposals cannot
 * surface a row the parser missed entirely, and a missed row is the failure a human
 * reviewer is least likely to catch unaided. Showing the blanks is what makes
 * verification more than rubber-stamping.
 */
export function anchoredRows(
  spec: FormSpec,
  words: readonly AnchorWord[],
  opts: AnchorOptions = {},
): AnchoredRow[] {
  const { bandFraction } = { ...DEFAULTS, ...opts }
  const reach = opts.reach ?? defaultReach(spec)
  const gutters = findGutters(spec, words, opts)
  const out: AnchoredRow[] = []
  const seen = new Set<number>()

  for (const gutter of gutters) {
    for (const anchor of gutter.anchors) {
      const parsed = asRowKey(spec, anchor.text)
      if (!parsed || seen.has(parsed.key)) continue
      seen.add(parsed.key)

      const gx = gutter.line.a + gutter.line.b * anchor.cy
      const half = gutter.pitch * bandFraction

      const cells = words
        .filter(
          (w) =>
            Math.abs(w.cy - anchor.cy) < half && w.cx > gx + 0.002 && w.cx < gx + reach,
        )
        .sort((a, b) => a.cx - b.cx)

      out.push({ rowKey: parsed.key, keyConfidence: anchor.confidence, cy: anchor.cy, cells })
    }
  }

  return out.sort((a, b) => a.rowKey - b.rowKey)
}

/**
 * Rows whose key is printed as a label rather than a bare number — `G1`…`G7` mapped
 * onto a numeric key space.
 *
 * These can't join the gutter fit: there are too few of them, and they sit in their
 * own block. They anchor on their own label instead.
 */
export function anchoredLabelRows(
  spec: FormSpec,
  words: readonly AnchorWord[],
  opts: AnchorOptions = {},
): AnchoredRow[] {
  const label = spec.rowKey.labelPattern
  if (!label) return []

  const reach = opts.reach ?? defaultReach(spec)
  const re = new RegExp(label.pattern, 'i')
  const out: AnchoredRow[] = []

  for (const w of words.filter((x) => re.test(x.text.trim())).sort((a, b) => a.cy - b.cy)) {
    const m = re.exec(w.text.trim())
    if (!m?.[1]) continue
    const key = label.base + Number(m[1])
    if (!spec.rowKey.ranges.some((r) => key >= r.from && key <= r.to)) continue

    const cells = words
      .filter((c) => Math.abs(c.cy - w.cy) < label.bandHalfHeight && c.cx > w.cx + 0.002 && c.cx < w.cx + reach)
      .sort((a, b) => a.cx - b.cx)

    out.push({ rowKey: key, keyConfidence: w.confidence, cy: w.cy, cells })
  }

  return out
}
