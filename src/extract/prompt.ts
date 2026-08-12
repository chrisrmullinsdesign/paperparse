/**
 * Prompt and output-schema construction from a FormSpec.
 *
 * The prompt is generated rather than hand-written so that the instructions, the
 * JSON schema, and the validator can never drift apart — all three read the same
 * field list. Adding a field to the spec updates what the model is asked for, what
 * shape it is allowed to return, and what gets checked, in one edit.
 */

import type { FieldSpec, FormSpec, KeyRange } from '../formspec/types.js'

function describeRanges(ranges: KeyRange[]): string {
  return ranges
    .map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`))
    .join(', ')
}

function describeField(f: FieldSpec): string {
  const bits: string[] = [`- \`${f.name}\` (${f.type})`]
  if (f.type === 'enum' && f.values?.length) {
    bits.push(`one of: ${f.values.map((v) => `"${v}"`).join(', ')}.`)
  }
  bits.push(f.description)
  if (f.required === false) bits.push('Optional — omit if the cell is blank.')
  return bits.join(' ')
}

/** Fields the model is asked for. PII fields are excluded by construction. */
export function extractableFields(spec: FormSpec): FieldSpec[] {
  return spec.fields.filter((f) => !f.pii)
}

/**
 * The system prompt for a full-document extraction pass.
 *
 * Written at normal volume. Current models follow instructions closely, so the
 * emphasis-stacking that older models needed ("CRITICAL: you MUST...") now
 * over-applies — it pushes the model toward reporting rows it half-guessed rather
 * than leaving them out. State the rule once and give the reason.
 */
export function buildExtractionPrompt(spec: FormSpec): string {
  const fields = extractableFields(spec)
  const piiFields = spec.fields.filter((f) => f.pii)

  const sections: string[] = []

  sections.push(`You are transcribing a photograph of a paper form: ${spec.title}.

${spec.description}`)

  sections.push(`## What to return

For every row that has been filled in, return one object with:

- \`row_key\` (integer) — ${spec.rowKey.description} Valid values: ${describeRanges(spec.rowKey.ranges)}.
- \`fields\` — an object with these keys:
${fields.map(describeField).join('\n')}
- \`confidence\` — "high", "medium", or "low", reflecting how clearly you could read this specific row.`)

  if (piiFields.length > 0) {
    sections.push(`## What to leave out

The form also has ${piiFields.map((f) => `a ${f.description.toLowerCase().replace(/\.$/, '')}`).join(' and ')}. Do not transcribe ${piiFields.length > 1 ? 'those columns' : 'that column'} — ${piiFields.length > 1 ? 'they are' : 'it is'} personal information and ${piiFields.length > 1 ? 'they are' : 'it is'} not needed. Read past ${piiFields.length > 1 ? 'them' : 'it'} to the fields listed above.`)
  }

  sections.push(`## Reading the form

Work down the printed row-key column and read across. Follow the printed row keys rather than visual row order — on a two-column layout the row above another on the page is not necessarily the next row in sequence.

Transcribe only rows that have been written in. Skip blank rows entirely; do not carry a value down from the row above or across from a neighbouring column to fill a gap.

When a cell is partly illegible, infer from context where you reasonably can and mark that row "medium" or "low". When you cannot read it at all and cannot infer it, omit the row and say so in \`notes\`. A row left out is recoverable by a human reviewer; a confidently wrong row is not.

Use \`notes\` for anything that affected your reading — glare, a fold, ambiguous handwriting, rows you skipped and why.

Set \`looks_like_expected_form\` to false only if this is clearly a different document. Partial glare, blur, or a cropped edge still counts as the expected form if you can read any rows from it.`)

  if (spec.promptAppendix) sections.push(spec.promptAppendix.trim())

  if (spec.examples?.length) {
    sections.push(`## Illustrative output

Structure only — these values are invented and are not from any real form.

${spec.examples.join('\n\n')}`)
  }

  return sections.join('\n\n')
}

/**
 * Prompt for a single cropped section.
 *
 * The crop already limits what is visible, but naming the expected keys anyway
 * gives the model a checklist and makes a missing row visible as an absence
 * rather than something it has to notice on its own.
 */
export function buildSectionPrompt(
  spec: FormSpec,
  keys: readonly number[],
  documentDate?: string | null,
): string {
  const base = buildExtractionPrompt(spec)
  const range = keys.length > 1 ? `${keys[0]}–${keys[keys.length - 1]}` : `${keys[0]}`

  // Without this, a crop showing "10/28" has no year anywhere in frame and the model
  // must guess one. It usually guesses well and says so in its notes — but a good
  // guess and a read are indistinguishable to everything downstream.
  const context = documentDate
    ? `\n\nThe form's header — not visible in this crop — reads ${documentDate}. Resolve partial dates against that: use its year, and roll over to the next year for any date that would otherwise fall implausibly far before it.\n\nSet \`document_date\` to ${documentDate}.`
    : `\n\nThe form's header is not visible in this crop. If a date is written without a year, infer the most plausible one from the other dates in view and mark the row "medium" rather than "high". Set \`document_date\` to null.`

  return `${base}

## This request

You are looking at a crop of the form covering rows ${range} only.

Return rows only for keys in that range. The crop may include a partial row above or below the range — ignore those; another pass covers them. If a row inside the range is blank, leave it out.${context}`
}

/**
 * Prompt for the header pass — one cheap request that reads only the document date.
 *
 * Kept separate from the row extraction so it can run against a small crop of the
 * top of the form rather than the whole page.
 */
export function buildHeaderPrompt(spec: FormSpec): string {
  return `This is a crop of the top of a paper form: ${spec.title}.

${spec.description}

Read only the document-level date — the date printed or handwritten at the top of the sheet indicating when it was current. It may appear as a heading, an "as of" line, or a handwritten date and time.

Return it as \`document_date\` in YYYY-MM-DD form. If the year is not written, infer it from any other context visible in the crop; if you cannot determine the date at all, return null.

Return no rows — set \`rows\` to an empty array.`
}

/**
 * JSON Schema for structured outputs.
 *
 * Kept inside the documented subset: `additionalProperties: false` everywhere, no
 * numeric bounds, no string-length constraints. Range checks on `row_key` belong to
 * the validator anyway — a schema rejection loses the whole response, while the
 * validator drops one bad row and tells you which.
 */
export function buildOutputSchema(spec: FormSpec): Record<string, unknown> {
  const fields = extractableFields(spec)

  const fieldProps: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.type === 'integer') fieldProps[f.name] = { type: 'integer', description: f.description }
    else if (f.type === 'enum') fieldProps[f.name] = { type: 'string', enum: f.values ?? [], description: f.description }
    else if (f.type === 'iso-date') fieldProps[f.name] = { type: 'string', format: 'date', description: f.description }
    else fieldProps[f.name] = { type: 'string', description: f.description }
  }

  const requiredFields = fields.filter((f) => f.required !== false).map((f) => f.name)

  return {
    type: 'object',
    additionalProperties: false,
    required: ['document_date', 'rows', 'notes', 'looks_like_expected_form'],
    properties: {
      document_date: {
        type: ['string', 'null'],
        description: 'Date printed at the top of the form as YYYY-MM-DD, or null if absent or illegible.',
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['row_key', 'fields', 'confidence'],
          properties: {
            row_key: { type: 'integer', description: spec.rowKey.description },
            fields: {
              type: 'object',
              additionalProperties: false,
              required: requiredFields,
              properties: fieldProps,
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
      notes: { type: 'string', description: 'Anything that affected the reading. Empty string if nothing.' },
      looks_like_expected_form: { type: 'boolean' },
    },
  }
}
