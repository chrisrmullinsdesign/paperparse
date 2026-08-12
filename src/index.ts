/** Public surface. */

// The core abstraction
export type {
  FormSpec,
  FieldSpec,
  FieldType,
  RowKeySpec,
  LayoutSpec,
  LayoutBlock,
  KeyRange,
  NormRect,
  RedactColumn,
} from './formspec/types.js'

export {
  blockForKey,
  rowPitch,
  rectForKey,
  rectForKeys,
  expandByRows,
  pitchForKeys,
  sectionChunks,
  allValidKeys,
  isValidRowKey,
  blockAtPoint,
  keyAtNormPoint,
  fieldAtNormPoint,
} from './formspec/geometry.js'

// Data shapes
export type {
  Confidence,
  RawRow,
  ExtractionResult,
  ValidatedRow,
  DropReason,
  ValidationStats,
  ValidationOutput,
  PipelineMeta,
  Ambiguity,
  AmbiguityCandidate,
  AmbiguityKind,
  AmbiguityStatus,
} from './types.js'

// Image
export { prepareForVision, stripImage, enhance, downscale, imageSize } from './image/prep.js'
export { cropNormRect, cropPixels, normRectToPixels } from './image/crop.js'
export { splitVertically, mergeSplitResults } from './image/split.js'

// Extraction
export type { Backend, ExtractRequest, ExtractResponse, StrategyConfig, StrategyName, UsageTotals } from './extract/backend.js'
export { resolveStrategy, addUsage, sumUsage, ZERO_USAGE } from './extract/backend.js'
export { AnthropicBackend, normalizeResult } from './extract/anthropic.js'
export { TextractBackend, placeWords, assembleRows } from './extract/textract.js'
export type { TextractBackendOptions } from './extract/textract.js'
export { EscalatingBackend } from './extract/escalate.js'
export type { EscalateOptions } from './extract/escalate.js'
export { buildExtractionPrompt, buildSectionPrompt, buildOutputSchema, extractableFields } from './extract/prompt.js'
export { extractBySections } from './extract/sections.js'
export { extractJsonObject, parseJsonObject } from './extract/json.js'

// Validation
export { validateRow, validateExtraction, toIsoDate } from './validate/rows.js'
export type { RowRule, ValidateOptions } from './validate/rows.js'
export { normalizeYears } from './validate/years.js'

// Eval
export { multisetDiff, fieldAccuracy, rowSignature, rowKeySignature } from './eval/diff.js'
export type { MultisetDiff, FieldAccuracy } from './eval/diff.js'
export { prf, microAverage, formatPct } from './eval/metrics.js'
export type { Prf } from './eval/metrics.js'
export { runBenchmark, formatBenchmarkTable, costOf, OPUS_5_PRICING } from './eval/benchmark.js'
export type { GoldSample, BenchConfig, ConfigOutcome, SampleOutcome, Pricing } from './eval/benchmark.js'
export { generateAmbiguities, ambiguitiesForRow } from './eval/ambiguity.js'

// Redaction
export { locateRedactionRegions, blurRegions, redactImage } from './redact/pii.js'
export type { RedactionRegion } from './redact/pii.js'

// Pipeline
export { runPipeline } from './pipeline.js'
export type { PipelineOptions, PipelineResult, ReadMode } from './pipeline.js'
