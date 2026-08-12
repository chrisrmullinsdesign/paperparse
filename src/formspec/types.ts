/**
 * A FormSpec is a declarative description of one physical paper form.
 *
 * Everything downstream — prompt construction, section cropping, row validation,
 * PII redaction, and the eval harness — is driven by this object. Adding support
 * for a new form means writing a spec, not editing the pipeline.
 *
 * The worked example in `examples/campground-roster` is a real-world spec for a
 * 107-row printed roster photographed on a clipboard.
 */

/** Normalized rectangle — fractions of image width/height, origin top-left. */
export interface NormRect {
  x: number
  y: number
  w: number
  h: number
}

/** An inclusive integer range of row keys, in printed order. */
export interface KeyRange {
  from: number
  to: number
}

/**
 * One printed block of rows on the page.
 *
 * A form is rarely a single uniform grid. Real ones have a left and right column,
 * a highlighted band partway down, and an odd cluster of extra rows at the bottom.
 * Each of those is a block with its own coordinates and its own row pitch.
 *
 * Blocks are resolved **in declaration order, first match wins**. That ordering is
 * load-bearing: it lets a narrow band (say, rows 90–98 in a separate highlighted
 * strip) take precedence over the wide column whose numeric range contains it.
 */
export interface LayoutBlock {
  id: string
  /** Row keys this block is responsible for. */
  keys: KeyRange
  /** Normalized horizontal extent [left, right]. */
  x: [number, number]
  /** Normalized vertical extent [top, bottom]. */
  y: [number, number]
  /**
   * How many printed row slots span `y`. Usually `keys.to - keys.from + 1`, but not
   * always: a column printed with 50 slots may only *resolve* 40 of them if a later
   * band claims the rest. Row pitch is `(y[1] - y[0]) / rowSlots`, so getting this
   * right is what keeps crops aligned to the printed rules.
   */
  rowSlots: number
  /** Slot index of `keys.from` within the block. Defaults to 0. */
  slotOffset?: number
}

export interface LayoutSpec {
  /** Blocks in resolution order — earlier entries win. */
  blocks: LayoutBlock[]
  /**
   * Where the document-level header sits — the printed or handwritten date at the
   * top of the form.
   *
   * Declare this whenever the rows carry partial dates (a `10/28` with no year).
   * Section crops show the model ten rows and nothing else, so the year that lives
   * in the header is simply not in frame; without it the model has to guess, and
   * a plausible guess is indistinguishable from a correct one downstream.
   *
   * When set, sectioned extraction spends one extra small request reading this
   * region and passes the result into every section prompt as context.
   */
  headerRegion?: NormRect
  /**
   * Vertical padding applied to a single-row crop, as a fraction of row pitch.
   * Handwriting routinely overflows its printed row; without padding the
   * ascenders and descenders get clipped.
   */
  rowPadFraction?: number
  /** Rows per crop when running the section-by-section extraction pass. */
  sectionChunkRows?: number
}

/** How a field should be parsed and validated once the model returns it. */
export type FieldType = 'iso-date' | 'integer' | 'string' | 'enum'

export interface FieldSpec {
  /** Key in the emitted JSON. Snake_case reads more naturally to the model. */
  name: string
  type: FieldType
  /** Shown to the model. Say where the value is printed and what it means. */
  description: string
  /** When false, a row missing this field is still accepted. */
  required?: boolean
  /** For `enum` fields. */
  values?: string[]
  /**
   * Marks a field as personally identifying. PII fields are never emitted by the
   * extraction prompt, and their columns are targets for redaction.
   */
  pii?: boolean
  /**
   * Horizontal extent of this field's printed column, as a fraction of the
   * containing block's width — `[0, 1]` spans the block, `[0.58, 0.78]` is a column
   * a bit right of centre.
   *
   * Optional, and unused by the vision backends: a vision model reads the columns
   * from the image. It is what lets a **geometric** backend work at all — an OCR or
   * document-AI service returns words with bounding boxes and no idea which of them
   * is a departure date, and this is the mapping that answers that. Declare it if
   * you intend to run anything other than a vision model against the form.
   */
  column?: [number, number]
}

/** The field that identifies a row — the printed row number, ID, or line number. */
export interface RowKeySpec {
  name: string
  description: string
  /**
   * Valid key ranges. Multiple ranges let a form encode a second series (e.g.
   * lettered group rows mapped onto a numeric range above the main grid).
   */
  ranges: KeyRange[]
}

/** A column region that may contain PII, located for redaction. */
export interface RedactColumn {
  /** Column label as printed on the form — used to locate it visually. */
  label: string
  /** Rough normalized horizontal extent, if known. Narrows the search. */
  xHint?: [number, number]
}

export interface FormSpec {
  id: string
  title: string
  /**
   * What the form is, in prose, as context for the vision model. Describe the
   * physical artifact: what is printed vs handwritten, how the grid is laid out,
   * what the headers look like, and any quirks a first-time reader would miss.
   */
  description: string
  rowKey: RowKeySpec
  /** Non-PII fields to extract per row. */
  fields: FieldSpec[]
  layout: LayoutSpec
  /** Columns to locate and blur when producing a shareable copy of the image. */
  redactColumns?: RedactColumn[]
  /**
   * Extra prompt text appended verbatim after the generated instructions —
   * form-specific reading hints that don't fit the structured fields above.
   */
  promptAppendix?: string
  /**
   * Illustrative extraction outputs. Structure only, synthetic values — never
   * paste a real extraction here, and never enough of them to pin the model to
   * one shape.
   */
  examples?: string[]
}
