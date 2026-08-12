/**
 * The backend interface.
 *
 * A backend turns (image, FormSpec, prompt) into an ExtractionResult. Everything
 * above this line — sectioning, splitting, validation, the eval harness — is
 * backend-agnostic, which is what makes it possible to benchmark two models against
 * the same gold set and get a comparison rather than two unrelated numbers.
 */

import type { FormSpec } from '../formspec/types.js'
import type { ExtractionResult } from '../types.js'

export interface ExtractRequest {
  /** JPEG bytes. Already stripped and prepared — backends do not modify the image. */
  image: Buffer
  spec: FormSpec
  /** Full prompt text, from `buildExtractionPrompt` or `buildSectionPrompt`. */
  prompt: string
  /** Present when this request covers a cropped section rather than the whole form. */
  sectionKeys?: readonly number[]
}

export interface ExtractResponse {
  result: ExtractionResult
  /** Model identifier that actually served the request. */
  model: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface Backend {
  /** Stable identifier, recorded in `PipelineMeta.backend` and in eval output. */
  readonly name: string
  /** False when required credentials are absent, so selection can skip it. */
  isAvailable(): boolean
  extract(req: ExtractRequest): Promise<ExtractResponse>
}

export type StrategyName = 'single' | 'dual' | 'escalate'

export interface StrategyConfig {
  /**
   * - `single`   — one backend, one pass.
   * - `dual`     — every backend in parallel, every time; keep the result with the
   *                most validated rows. Highest cost, highest recall, and it gives
   *                you a per-image disagreement signal for free.
   * - `escalate` — run the primary; run the others only when the primary's result
   *                falls below `escalateMinRows` or the form reads as empty. Most
   *                of the accuracy of `dual` at close to the cost of `single`,
   *                because the primary is usually fine.
   */
  strategy: StrategyName
  /** Row count below which `escalate` triggers a second opinion. */
  escalateMinRows?: number
}

/**
 * Pick the primary backend and strategy from what is available.
 *
 * Deliberately explicit about the both-available case rather than picking silently:
 * with two backends configured, the interesting default is `escalate`, because the
 * whole point of having a second one is to catch the first one's bad days.
 */
export function resolveStrategy(backends: Backend[], requested?: Partial<StrategyConfig>): StrategyConfig {
  const available = backends.filter((b) => b.isAvailable())
  if (requested?.strategy) {
    return { strategy: requested.strategy, escalateMinRows: requested.escalateMinRows ?? 1 }
  }
  return {
    strategy: available.length > 1 ? 'escalate' : 'single',
    escalateMinRows: requested?.escalateMinRows ?? 1,
  }
}
