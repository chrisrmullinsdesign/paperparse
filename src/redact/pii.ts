/**
 * PII redaction.
 *
 * The extraction prompt already declines to transcribe PII columns, so no personal
 * data enters the structured output. That covers the data. It does not cover the
 * *image* — and the image is the thing you end up wanting to publish as a worked
 * example, attach to a bug report, or hand to a labeller.
 *
 * This locates the sensitive columns visually and blurs them, so a shareable copy of
 * the photograph can be produced from the original without a human cropping it by hand.
 *
 * A caveat worth stating plainly: this is model-located, so it is a best effort, not
 * a guarantee. For anything with real consequences, treat the output as a draft for
 * human review — or don't publish the image at all.
 */

import sharp from 'sharp'
import Anthropic from '@anthropic-ai/sdk'
import { parseJsonObject } from '../extract/json.js'
import { normRectToPixels } from '../image/crop.js'
import { imageSize } from '../image/prep.js'
import type { FormSpec, NormRect } from '../formspec/types.js'

/** Extra margin around a located region, as a fraction of its size. */
const REGION_PAD = 0.02

export interface RedactionRegion extends NormRect {
  label: string
}

const LOCATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['regions'],
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'x', 'y', 'w', 'h'],
        properties: {
          label: { type: 'string', description: 'Which requested column this region covers.' },
          x: { type: 'number', description: 'Left edge, as a fraction of image width (0–1).' },
          y: { type: 'number', description: 'Top edge, as a fraction of image height (0–1).' },
          w: { type: 'number', description: 'Width, as a fraction of image width (0–1).' },
          h: { type: 'number', description: 'Height, as a fraction of image height (0–1).' },
        },
      },
    },
  },
} as const

function buildLocatePrompt(spec: FormSpec): string {
  const columns = spec.redactColumns ?? []
  const described = columns
    .map((c) => {
      const hint = c.xHint
        ? ` It sits roughly between ${c.xHint[0]} and ${c.xHint[1]} across the image width.`
        : ''
      return `- "${c.label}"${hint}`
    })
    .join('\n')

  return `This is a photograph of a paper form: ${spec.title}.

${spec.description}

Locate the following handwritten columns so they can be blurred out:

${described}

For each column you can find, return a rectangle in normalized coordinates covering the full vertical extent of that column's handwritten entries, from the first filled row to the last. Include the column's full width plus a little margin — it is better to cover slightly too much than to leave part of a name visible.

Coordinates are fractions of the image dimensions: x and y are the top-left corner, w and h the size, all between 0 and 1.

If a column is not visible in this image, leave it out.`
}

/** Ask the model where the sensitive columns are. */
export async function locateRedactionRegions(
  image: Buffer,
  spec: FormSpec,
  opts: { client?: Anthropic; model?: string } = {},
): Promise<RedactionRegion[]> {
  if (!spec.redactColumns?.length) return []

  const client = opts.client ?? new Anthropic()
  const stream = client.messages.stream({
    model: opts.model ?? process.env.PAPERPARSE_ANTHROPIC_MODEL ?? 'claude-opus-5',
    max_tokens: 8_000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: LOCATE_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
          { type: 'text', text: buildLocatePrompt(spec) },
        ],
      },
    ],
  })

  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') return []

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const parsed = parseJsonObject<{ regions: RedactionRegion[] }>(text)
  if (!parsed?.regions) return []

  return parsed.regions.filter(
    (r) =>
      Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0,
  )
}

function padRect(rect: NormRect): NormRect {
  const padX = rect.w * REGION_PAD
  const padY = rect.h * REGION_PAD
  const x = Math.max(0, rect.x - padX)
  const y = Math.max(0, rect.y - padY)
  return {
    x,
    y,
    w: Math.min(1 - x, rect.w + 2 * padX),
    h: Math.min(1 - y, rect.h + 2 * padY),
  }
}

/**
 * Blur the given regions into the image.
 *
 * Heavy Gaussian blur rather than a solid fill. A solid box is more obviously
 * irreversible, but blurring keeps the form legible as a form — a reader can still
 * see that a column exists and was filled in, which is what makes the redacted
 * image useful as an example rather than just a censored one. Use a sigma this
 * large and the text is not recoverable.
 */
export async function blurRegions(
  image: Buffer,
  regions: readonly NormRect[],
  opts: { sigma?: number; quality?: number } = {},
): Promise<Buffer> {
  if (regions.length === 0) return image

  const { width, height } = await imageSize(image)
  const sigma = opts.sigma ?? Math.max(8, Math.round(Math.min(width, height) / 90))

  const overlays = await Promise.all(
    regions.map(async (region) => {
      const px = normRectToPixels(padRect(region), width, height)
      const patch = await sharp(image).extract(px).blur(sigma).toBuffer()
      return { input: patch, left: px.left, top: px.top }
    }),
  )

  return sharp(image)
    .composite(overlays)
    .jpeg({ quality: opts.quality ?? 90, mozjpeg: true })
    .toBuffer()
}

/** Locate and blur in one call — produce a shareable copy of a form photograph. */
export async function redactImage(
  image: Buffer,
  spec: FormSpec,
  opts: { client?: Anthropic; model?: string; sigma?: number } = {},
): Promise<{ image: Buffer; regions: RedactionRegion[] }> {
  const regions = await locateRedactionRegions(image, spec, opts)
  return { image: await blurRegions(image, regions, { sigma: opts.sigma }), regions }
}
