/**
 * Anthropic backend — the reference implementation.
 *
 * Two things here are worth noting if you are porting this pattern:
 *
 *  1. **Structured outputs, not prose parsing.** `output_config.format` constrains
 *     the response to the schema generated from the FormSpec, so there is no
 *     fenced-JSON extraction step and no retry-on-parse-failure loop. `json.ts`
 *     remains as a fallback for backends without schema enforcement.
 *
 *  2. **Streaming, always.** Not for UI — a full form can emit a lot of JSON, and
 *     `max_tokens` has to cover thinking plus output. At those values a
 *     non-streaming request risks an HTTP timeout, and streaming removes the
 *     question entirely.
 */

import Anthropic from '@anthropic-ai/sdk'
import { buildOutputSchema } from './prompt.js'
import { parseJsonObject } from './json.js'
import type { Backend, ExtractRequest, ExtractResponse } from './backend.js'
import type { ExtractionResult } from '../types.js'

/** Effort ladder. `high` is the API default; raise for hard captures, lower for cost. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthropicBackendOptions {
  model?: string
  /**
   * Must cover thinking *and* the emitted JSON. A 100-row form is a few thousand
   * tokens of output on its own; the default leaves room for both.
   */
  maxTokens?: number
  effort?: Effort
  apiKey?: string
  client?: Anthropic
}

const DEFAULT_MODEL = 'claude-opus-5'
const DEFAULT_MAX_TOKENS = 32_000

export class AnthropicBackend implements Backend {
  readonly name = 'anthropic'

  private readonly client: Anthropic
  private readonly model: string
  private readonly maxTokens: number
  private readonly effort: Effort

  constructor(opts: AnthropicBackendOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {})
    this.model = opts.model ?? process.env.PAPERPARSE_ANTHROPIC_MODEL ?? DEFAULT_MODEL
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
    this.effort = opts.effort ?? 'high'
  }

  isAvailable(): boolean {
    // An `ant auth login` profile also authenticates, so a missing env var is not
    // proof of missing credentials — but it is the only signal available without
    // making a request, and a wrong "available" costs a failed API call.
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim())
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    const schema = buildOutputSchema(req.spec)

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: req.image.toString('base64') },
            },
            { type: 'text', text: req.prompt },
          ],
        },
      ],
    })

    const message = await stream.finalMessage()

    // Safety classifiers can decline a request with a normal 200 response, so check
    // `stop_reason` before touching `content` — indexing it unconditionally throws
    // on a refusal, where `content` is empty.
    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Anthropic backend: request declined (${message.stop_details?.category ?? 'unspecified'})`,
      )
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    if (!text.trim()) {
      throw new Error(`Anthropic backend: empty response (stop_reason: ${message.stop_reason})`)
    }

    const parsed = parseJsonObject<ExtractionResult>(text)
    if (!parsed) {
      // Reaching here means the schema constraint did not hold — worth surfacing
      // loudly rather than silently returning zero rows, because it points at a
      // schema/model mismatch rather than a hard-to-read photograph.
      throw new Error(
        `Anthropic backend: response was not valid JSON despite output schema (stop_reason: ${message.stop_reason})`,
      )
    }

    return {
      result: normalizeResult(parsed),
      model: message.model,
      usage: {
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
      },
    }
  }
}

/** Defensive normalization — a backend must always hand back a well-formed shape. */
export function normalizeResult(raw: Partial<ExtractionResult>): ExtractionResult {
  return {
    document_date: typeof raw.document_date === 'string' ? raw.document_date : null,
    rows: Array.isArray(raw.rows) ? raw.rows : [],
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    looks_like_expected_form: raw.looks_like_expected_form !== false,
  }
}
