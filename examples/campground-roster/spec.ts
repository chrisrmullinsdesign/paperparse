/**
 * Worked example: a campground sign-up roster.
 *
 * This is modelled on a real artifact — a printed 107-row roster on a clipboard at a
 * state forest headquarters, photographed by visitors on their phones. Campers write
 * their name, permit number, and stay dates against a site number; the sheet is the
 * only record of which sites are taken.
 *
 * The place names here are fictional. The layout is not: the two-column grid with a
 * separate highlighted band partway down the right column and a cluster of lettered
 * group sites at the bottom left is what makes this a useful example. A form that was
 * a clean uniform grid would not exercise the geometry at all.
 *
 * Three things about it are worth reading the coordinates for:
 *
 *  1. The right column is declared with 50 row slots but only resolves 39 of them —
 *     rows 90–98 belong to the highlighted band, which is declared first and wins.
 *     Row pitch still has to be computed over all 50 slots or every crop below row
 *     51 drifts upward.
 *  2. The group-site rows are numbered G1–G7 on paper. They are mapped onto keys
 *     101–107 so the whole form has a single integer key space, which is what lets
 *     validation, diffing, and geometry stay type-simple.
 *  3. Names and permit numbers are declared as fields but marked `pii`, so they are
 *     described to the redaction pass and excluded from the extraction prompt.
 */

import type { FormSpec } from '../../src/formspec/types.js'
import type { RowRule } from '../../src/validate/rows.js'

const BODY_TOP = 0.11
const BODY_BOTTOM = 0.91
const LEFT: [number, number] = [0.02, 0.49]
const RIGHT: [number, number] = [0.51, 0.99]

// The left column stops short of the body's foot to leave room for the group block
// beneath it, so the two columns run at different row pitches. The right column uses
// the full body height for its 50 slots.
const LEFT_BOTTOM = 0.75
const RIGHT_PITCH = (BODY_BOTTOM - BODY_TOP) / 50

// The highlighted band is not extra rows bolted onto the sheet — it *is* right-column
// slots 39 through 47, printed with a yellow header over them. Deriving its extent
// from the column pitch rather than eyeballing it is what keeps the two from
// overlapping: get this wrong and crops for rows 76-89 and 90-98 fight over the same
// pixels.
const BAND_TOP = BODY_TOP + 39 * RIGHT_PITCH
const BAND_BOTTOM = BODY_TOP + 48 * RIGHT_PITCH

export const campgroundRosterSpec: FormSpec = {
  id: 'campground-roster',
  title: 'Cedar Hollow State Forest campsite sign-up roster',

  description: `A printed grid on a clipboard at the forest headquarters, filled in by hand as campers arrive. The photograph is usually taken on a phone, often at an angle, sometimes with glare from the plastic clipboard cover.

The grid is printed in two columns. The left column lists sites 1–50 top to bottom; the right column continues with 51–100. Partway down the right column, a band with a yellow header labelled "RIVER BEND SITES" covers sites 90–98 — it is part of the same printed sheet but visually separate. At the bottom of the left column sit seven group sites labelled G1 through G7.

Each row has: the printed site number, then handwritten columns for last name, permit number, date in, and date out. Dates are usually written as month/day with no year, sometimes with a two-digit year.`,

  rowKey: {
    name: 'row_key',
    description:
      'The printed site number. Sites G1 through G7 at the bottom of the left column are numbered 101 through 107 respectively — write G1 as 101, G2 as 102, and so on through G7 as 107.',
    ranges: [
      { from: 1, to: 100 },
      { from: 101, to: 107 },
    ],
    // G1-G7 print a letter, not a number, so they can't join the gutter fit — too
    // few of them, and they sit in their own block. They anchor on their own label.
    labelPattern: { pattern: '^G([1-7])$', base: 100, bandHalfHeight: 0.007 },
  },

  fields: [
    // Two independent mappings for the geometric backend, and they disagree about
    // this form on purpose.
    //
    // `column` is an x-window into the *synthetic* fixture's layout, which prints
    // name and permit before the dates. It only works on a rectified page.
    //
    // `order` is the reading order of the *real* artifact, whose printed columns run
    // SITE # | DATE IN | DATE OUT | # OF PEOPLE | Last Name | Permit # — dates come
    // immediately after the site number. Order is what the anchored mode uses, and
    // it is the one to trust: it survives keystone, skew, and an arbitrary crop,
    // and it needed no measurement of the photograph to write down.
    {
      name: 'last_name',
      type: 'string',
      description: 'Handwritten last name of the camper.',
      pii: true,
      column: [0.10, 0.36],
      order: 2,
    },
    {
      name: 'permit_number',
      type: 'string',
      description: 'Handwritten permit number.',
      pii: true,
      column: [0.36, 0.58],
      order: 3,
    },
    {
      name: 'date_in',
      type: 'iso-date',
      description:
        'Arrival date, as YYYY-MM-DD. The paper usually shows month/day only — take the year from the sheet header, or from the other dates on the sheet if the header is illegible.',
      column: [0.58, 0.78],
      order: 0,
    },
    {
      name: 'date_out',
      type: 'iso-date',
      description:
        'Departure date, as YYYY-MM-DD. This is the day the site frees up, so it is always after the arrival date.',
      column: [0.78, 1.0],
      order: 1,
    },
  ],

  layout: {
    rowPadFraction: 0.1,
    sectionChunkRows: 10,

    // The "as of <date>" line above the grid. Rows carry month/day only, so without
    // this the year is absent from every section crop.
    headerRegion: { x: 0, y: 0, w: 1, h: BODY_TOP },

    // Order is precedence. The river-bend band must be declared before the right
    // column, whose numeric range contains it.
    blocks: [
      {
        id: 'main-left',
        keys: { from: 1, to: 50 },
        x: LEFT,
        y: [BODY_TOP, LEFT_BOTTOM],
        rowSlots: 50,
      },
      {
        id: 'river-bend',
        keys: { from: 90, to: 98 },
        x: RIGHT,
        y: [BAND_TOP, BAND_BOTTOM],
        rowSlots: 9,
      },
      {
        id: 'main-right',
        keys: { from: 51, to: 100 },
        x: RIGHT,
        y: [BODY_TOP, BODY_BOTTOM],
        // 50 slots, of which this block resolves 41 — 51-89 plus the 99-100 tail.
        // Pitch must come from the slot count, not the resolved-key count, or every
        // crop below row 51 drifts upward by a growing margin.
        rowSlots: 50,
      },
      {
        id: 'group-sites',
        keys: { from: 101, to: 107 },
        x: LEFT,
        y: [LEFT_BOTTOM + 0.02, 0.89],
        rowSlots: 7,
      },
    ],
  },

  redactColumns: [
    { label: 'Last Name', xHint: [0.05, 0.25] },
    { label: 'Permit #', xHint: [0.2, 0.35] },
  ],

  promptAppendix: `Reading hints specific to this sheet:

Headers vary between printings — "SIGN-UP SHEET", "CAMPING ROSTER", "Check-in sheet", or just a handwritten date and time such as "as of 4:30 Fri". Any of these can carry the sheet date.

Photographs are often screenshots or crops shared online, so the image may include phone UI, a post title, or browser chrome around the edges. Ignore all of it; only the printed grid matters.

The two columns are one logical grid, not two. Follow the printed site numbers rather than reading straight across the page.

If both date cells on a row are blank, the site is unoccupied — leave the row out rather than copying a date from a neighbouring row.`,

  examples: [
    `{"document_date":"2024-10-25","looks_like_expected_form":true,"rows":[
  {"row_key":14,"fields":{"date_in":"2024-10-26","date_out":"2024-10-28"},"confidence":"high"},
  {"row_key":67,"fields":{"date_in":"2024-10-27","date_out":"2024-10-30"},"confidence":"medium"},
  {"row_key":103,"fields":{"date_in":"2024-10-25","date_out":"2024-10-27"},"confidence":"high"}
],"notes":"Glare on lower right; site 67 departure date estimated from partial digits."}`,
  ],
}

/**
 * Cross-field rules for this form.
 *
 * These live in code rather than in the spec because they are logic, not data — and
 * because keeping the FormSpec free of executable content means it stays
 * serializable and safe to load from disk.
 */
export const campgroundRosterRules: RowRule[] = [
  {
    id: 'departure-after-arrival',
    check(row) {
      const dateIn = String(row.fields.date_in ?? '')
      const dateOut = String(row.fields.date_out ?? '')
      if (!dateIn || !dateOut) return true
      return dateOut > dateIn ? true : `date_out ${dateOut} is not after date_in ${dateIn}`
    },
  },
  {
    id: 'stay-length-plausible',
    check(row) {
      const dateIn = new Date(`${row.fields.date_in}T00:00:00Z`).getTime()
      const dateOut = new Date(`${row.fields.date_out}T00:00:00Z`).getTime()
      if (Number.isNaN(dateIn) || Number.isNaN(dateOut)) return true
      const nights = Math.round((dateOut - dateIn) / 86_400_000)
      // The park's own limit is 14 nights, so a longer stay is a misread year or
      // month far more often than it is a real booking.
      return nights <= 14 ? true : `stay of ${nights} nights exceeds the 14-night limit`
    },
  },
]
