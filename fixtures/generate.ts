/**
 * Synthetic form generator.
 *
 * Renders fake filled-in rosters from a FormSpec, with ground truth falling out for
 * free — the generator knows what it wrote, so every image comes with a perfect
 * label set and the benchmark is reproducible from a clean clone.
 *
 * Synthetic rather than redacted real forms, deliberately. Redaction is a claim you
 * have to defend every time you publish; synthesis is not a claim at all. It also
 * means the corpus can be arbitrarily large and can target specific failure modes
 * on demand — glare over one column, a fold through the middle, a skewed capture.
 *
 * The generator reads its geometry from the same FormSpec the pipeline reads, so
 * generated rows land exactly where `rectForKey` expects them. That is what makes
 * the crops verifiable: if a section crop is misaligned, the bug is in the geometry,
 * not in a disagreement between two hand-maintained coordinate sets.
 */

import sharp from 'sharp'
import { blockForKey, rowPitch, allValidKeys } from '../src/formspec/geometry.js'
import type { FormSpec } from '../src/formspec/types.js'
import type { ValidatedRow } from '../src/types.js'

export interface GenerateOptions {
  /** Seed for reproducible output. Same seed, same image and same rows. */
  seed: number
  width?: number
  height?: number
  /** Fraction of rows to fill in. */
  fillRate?: number
  /** Capture degradations to apply. */
  augment?: Augmentation[]
}

export type Augmentation = 'glare' | 'skew' | 'blur' | 'crop' | 'shadow' | 'lowlight'

export interface GeneratedSample {
  image: Buffer
  rows: ValidatedRow[]
  /** Header date rendered on the sheet. */
  documentDate: string
}

/** mulberry32 — small, fast, seedable. Determinism is the requirement, not quality. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SURNAMES = [
  'Alvarez', 'Bennett', 'Castillo', 'Doyle', 'Ellsworth', 'Fontaine', 'Grigsby',
  'Hollande', 'Ives', 'Jankowski', 'Kestrel', 'Lindqvist', 'Marchetti', 'Nakamura',
  'Oyelaran', 'Prescott', 'Quill', 'Rasmussen', 'Sowande', 'Thornbury', 'Ueda',
  'Vasquez', 'Whitmore', 'Ximenes', 'Yarrow', 'Zabłocki',
]

/**
 * Handwriting stack. Which of these resolves depends on the host's installed fonts,
 * so output is reproducible on one machine but not necessarily pixel-identical
 * across machines — the row *values* are seeded and stable either way, which is what
 * the ground truth depends on.
 */
const HAND_FONT = "'Segoe Script','Bradley Hand','Chalkboard SE','Comic Sans MS',cursive"
const PRINT_FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isoDate(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime() + offsetDays * 86_400_000)
  return d.toISOString().slice(0, 10)
}

interface Cell {
  key: number
  lastName: string
  permit: string
  dateIn: string
  dateOut: string
}

function buildRows(spec: FormSpec, rand: () => number, fillRate: number, base: Date): Cell[] {
  const keys = allValidKeys(spec)
  const cells: Cell[] = []

  for (const key of keys) {
    if (rand() > fillRate) continue
    const arrive = Math.floor(rand() * 10) - 2
    const nights = 1 + Math.floor(rand() * 6)
    cells.push({
      key,
      lastName: SURNAMES[Math.floor(rand() * SURNAMES.length)],
      permit: String(10_000 + Math.floor(rand() * 89_999)),
      dateIn: isoDate(base, arrive),
      dateOut: isoDate(base, arrive + nights),
    })
  }
  return cells
}

/** Render printed rules, the header, and the handwritten entries as one SVG. */
function renderSvg(spec: FormSpec, cells: Cell[], documentDate: string, W: number, H: number, rand: () => number): string {
  const parts: string[] = []

  parts.push(`<rect width="${W}" height="${H}" fill="#f7f5ef"/>`)
  parts.push(
    `<text x="${W / 2}" y="${H * 0.05}" font-family=${JSON.stringify(PRINT_FONT)} font-size="${Math.round(H * 0.022)}" font-weight="bold" text-anchor="middle" fill="#1d1d1b">CEDAR HOLLOW STATE FOREST — CAMPING ROSTER</text>`,
  )
  parts.push(
    `<text x="${W / 2}" y="${H * 0.082}" font-family=${JSON.stringify(HAND_FONT)} font-size="${Math.round(H * 0.019)}" text-anchor="middle" fill="#16305c">as of ${esc(documentDate)}</text>`,
  )

  // Printed row rules and site numbers, straight from the spec's blocks.
  for (const block of spec.layout.blocks) {
    const pitch = rowPitch(block)
    const x0 = block.x[0] * W
    const x1 = block.x[1] * W

    if (block.id === 'river-bend') {
      // The band is a tint over rows the column already owns, plus a label — not a
      // separate strip inserted between them. Drawing it as an inserted strip is
      // what produced overlapping rows the first time round.
      parts.push(
        `<rect x="${x0}" y="${block.y[0] * H}" width="${x1 - x0}" height="${(block.y[1] - block.y[0]) * H}" fill="#ffe680"/>`,
        // Set along the outer edge, where no data column reaches — a horizontal
        // header would sit on top of the first band row's entries.
        `<text x="${x1 - 10}" y="${(block.y[0] + block.y[1]) * 0.5 * H}" transform="rotate(-90 ${x1 - 10} ${(block.y[0] + block.y[1]) * 0.5 * H})" font-family=${JSON.stringify(PRINT_FONT)} font-size="${Math.round(H * 0.0105)}" font-weight="bold" text-anchor="middle" fill="#7a5d00">RIVER BEND SITES</text>`,
      )
    }

    for (let key = block.keys.from; key <= block.keys.to; key++) {
      if (blockForKey(spec, key)?.id !== block.id) continue
      const slot = key - block.keys.from + (block.slotOffset ?? 0)
      const top = (block.y[0] + slot * pitch) * H
      const bottom = (block.y[0] + (slot + 1) * pitch) * H
      const mid = (top + bottom) * 0.5

      parts.push(`<line x1="${x0}" y1="${bottom}" x2="${x1}" y2="${bottom}" stroke="#9a9a94" stroke-width="1"/>`)

      const label = key >= 101 ? `G${key - 100}` : String(key)
      parts.push(
        `<text x="${x0 + 6}" y="${mid + 5}" font-family=${JSON.stringify(PRINT_FONT)} font-size="${Math.round(H * 0.011)}" fill="#3a3a36">${label}</text>`,
      )
    }

    parts.push(
      `<rect x="${x0}" y="${block.y[0] * H}" width="${x1 - x0}" height="${(block.y[1] - block.y[0]) * H}" fill="none" stroke="#6d6d68" stroke-width="1.5"/>`,
    )
  }

  // Handwritten entries, jittered so no two rows sit on the same baseline.
  for (const cell of cells) {
    const block = blockForKey(spec, cell.key)
    if (!block) continue
    const pitch = rowPitch(block)
    const slot = cell.key - block.keys.from + (block.slotOffset ?? 0)
    const mid = (block.y[0] + (slot + 0.5) * pitch) * H
    const x0 = block.x[0] * W
    const width = (block.x[1] - block.x[0]) * W
    const size = Math.round(H * 0.0125)

    const cols = [
      { text: cell.lastName, at: 0.14 },
      { text: cell.permit, at: 0.4 },
      { text: cell.dateIn.slice(5).replace('-', '/'), at: 0.63 },
      { text: cell.dateOut.slice(5).replace('-', '/'), at: 0.83 },
    ]

    for (const col of cols) {
      const jx = (rand() - 0.5) * 6
      const jy = (rand() - 0.5) * 5
      const rot = (rand() - 0.5) * 3
      const x = x0 + width * col.at + jx
      const y = mid + 4 + jy
      parts.push(
        `<text x="${x}" y="${y}" transform="rotate(${rot.toFixed(2)} ${x} ${y})" font-family=${JSON.stringify(HAND_FONT)} font-size="${size}" fill="#16305c">${esc(col.text)}</text>`,
      )
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`
}

/** Capture degradations, applied after render. These are what the pipeline must survive. */
async function applyAugmentations(
  image: Buffer,
  augment: Augmentation[],
  W: number,
  H: number,
  rand: () => number,
): Promise<Buffer> {
  let buf = image

  if (augment.includes('glare')) {
    // A bright elliptical wash, as from a clipboard's plastic cover.
    const cx = W * (0.35 + rand() * 0.3)
    const cy = H * (0.25 + rand() * 0.4)
    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><radialGradient id="g"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
        <ellipse cx="${cx}" cy="${cy}" rx="${W * 0.3}" ry="${H * 0.16}" fill="url(#g)"/>
      </svg>`,
    )
    buf = await sharp(buf).composite([{ input: overlay, blend: 'over' }]).toBuffer()
  }

  if (augment.includes('shadow')) {
    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0%" stop-color="#000" stop-opacity="0.38"/><stop offset="55%" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#s)"/>
      </svg>`,
    )
    buf = await sharp(buf).composite([{ input: overlay, blend: 'over' }]).toBuffer()
  }

  if (augment.includes('lowlight')) {
    buf = await sharp(buf).modulate({ brightness: 0.72, saturation: 0.85 }).toBuffer()
  }

  if (augment.includes('skew')) {
    const angle = (rand() - 0.5) * 4
    buf = await sharp(buf)
      .rotate(angle, { background: '#3b3a36' })
      .resize(W, H, { fit: 'cover', position: 'centre' })
      .toBuffer()
  }

  if (augment.includes('blur')) {
    buf = await sharp(buf).blur(0.8 + rand() * 0.9).toBuffer()
  }

  if (augment.includes('crop')) {
    // Clip an edge, as when the photographer misses part of the clipboard.
    const cut = Math.round(W * (0.02 + rand() * 0.04))
    buf = await sharp(buf)
      .extract({ left: cut, top: 0, width: W - cut, height: H })
      .resize(W, H, { fit: 'fill' })
      .toBuffer()
  }

  return buf
}

export async function generateSample(spec: FormSpec, opts: GenerateOptions): Promise<GeneratedSample> {
  const rand = rng(opts.seed)
  const W = opts.width ?? 1200
  const H = opts.height ?? 1600
  const fillRate = opts.fillRate ?? 0.45

  // Fixed base date so output does not change with the calendar.
  const base = new Date(Date.UTC(2024, 9, 25))
  const documentDate = isoDate(base, 0)

  const cells = buildRows(spec, rand, fillRate, base)
  const svg = renderSvg(spec, cells, documentDate, W, H, rand)

  let image = await sharp(Buffer.from(svg)).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  if (opts.augment?.length) image = await applyAugmentations(image, opts.augment, W, H, rand)
  image = await sharp(image).jpeg({ quality: 88, mozjpeg: true }).toBuffer()

  const rows: ValidatedRow[] = cells.map((c) => ({
    rowKey: c.key,
    fields: { date_in: c.dateIn, date_out: c.dateOut },
    confidence: 'high',
  }))

  return { image, rows, documentDate }
}

/** The standard corpus: one clean sample plus one per degradation. */
export const STANDARD_CORPUS: Array<{ id: string; opts: GenerateOptions }> = [
  { id: 'clean', opts: { seed: 1, fillRate: 0.5 } },
  { id: 'sparse', opts: { seed: 2, fillRate: 0.15 } },
  { id: 'full', opts: { seed: 3, fillRate: 0.9 } },
  { id: 'glare', opts: { seed: 4, fillRate: 0.5, augment: ['glare'] } },
  { id: 'skew', opts: { seed: 5, fillRate: 0.5, augment: ['skew'] } },
  { id: 'blur', opts: { seed: 6, fillRate: 0.5, augment: ['blur'] } },
  { id: 'lowlight-shadow', opts: { seed: 7, fillRate: 0.5, augment: ['lowlight', 'shadow'] } },
  { id: 'cropped-edge', opts: { seed: 8, fillRate: 0.5, augment: ['crop'] } },
  { id: 'worst-case', opts: { seed: 9, fillRate: 0.6, augment: ['glare', 'skew', 'blur', 'shadow'] } },
]
