/**
 * Core data shapes.
 *
 * Deliberately small. A row is a row key plus a bag of field values, and the
 * FormSpec says what those fields mean — so nothing here needs to change when
 * you add a new form.
 */

import type { NormRect } from './formspec/types.js'

export type Confidence = 'high' | 'medium' | 'low'

/** One row exactly as the model returned it — untrusted, unvalidated, any shape. */
export interface RawRow {
  row_key: unknown
  fields: Record<string, unknown>
  confidence: Confidence
}

/** Full structured output from one extraction pass. */
export interface ExtractionResult {
  /** Date printed at the top of the form, if legible and if the spec asks for one. */
  document_date: string | null
  rows: RawRow[]
  /** Free-text notes from the model about glare, ambiguity, illegible cells. */
  notes: string
  /**
   * False when the model believes this photograph is not the expected form at all.
   * Omitted or true is treated as acceptable, so an older backend that doesn't
   * populate it doesn't cause every image to be rejected.
   */
  looks_like_expected_form?: boolean
}

/** A row that survived validation. Field values are normalized to their declared types. */
export interface ValidatedRow {
  rowKey: number
  fields: Record<string, string | number>
  confidence: Confidence
}

export type DropReason =
  | 'invalid_row_key'
  | 'missing_required_field'
  | 'unparseable_field'
  | 'failed_field_rule'
  | 'failed_row_rule'
  | 'duplicate_row'

export interface ValidationStats {
  rawRowCount: number
  acceptedRowCount: number
  droppedRowCount: number
  dropsByReason: Partial<Record<DropReason, number>>
  /** Per-row detail, for showing an operator exactly what was thrown away and why. */
  drops: Array<{ rowKey: unknown; reason: DropReason; detail?: string }>
}

export interface ValidationOutput {
  /** Rows the parser is confident about. */
  rows: ValidatedRow[]
  /** Rows that passed validation but carry low confidence — hold for human review. */
  uncertainRows: ValidatedRow[]
  stats: ValidationStats
}

/** Which backend and strategy produced a given extraction. Recorded for eval. */
export interface PipelineMeta {
  recordedAt: string
  strategy: 'single' | 'dual' | 'escalate'
  backend: string
  model?: string
  /** True when the image was cropped into sections and read pass-by-pass. */
  sectionParse?: boolean
  sectionChunkCount?: number
  /** True when a portrait image was split into overlapping halves. */
  splitParse?: boolean
}

// ─── Ambiguities ──────────────────────────────────────────────────────────────

export type AmbiguityKind = 'row_key_read' | 'field_read' | 'duplicate_row'
export type AmbiguityStatus = 'open' | 'resolved_skip' | 'resolved_choice'

export interface AmbiguityCandidate {
  value: number | string
  /** Human-readable label for the choice button. */
  label: string
}

/**
 * A structured question for a human reviewer, generated from an uncertain row.
 *
 * The point of materializing these is that review becomes a queue of small,
 * answerable questions with a zoomed crop attached — rather than "here is a
 * photograph and a table, please diff them."
 */
export interface Ambiguity {
  id: string
  kind: AmbiguityKind
  /** Short machine-readable reason, shown to the reviewer. */
  reason: string
  rowRef: { rowKey: number; fields: Record<string, string | number> }
  /** Ordered choices; index 0 is the parser's best guess. */
  candidates: AmbiguityCandidate[]
  /** Crop rect so the UI can show the reviewer the actual pixels in question. */
  cropRect?: NormRect
  status: AmbiguityStatus
  resolvedValue?: number | string
  resolvedAt?: string
}
