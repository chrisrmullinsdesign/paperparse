/**
 * Image preparation before a vision call.
 *
 * Three separate concerns, deliberately kept separate because they have different
 * failure modes: strip metadata (privacy), optionally enhance (accuracy), and
 * downscale (cost). Only the first is unconditional.
 */

import sharp from 'sharp'

export interface PrepOptions {
  /** Mild contrast/sharpen pass. Off by default — see `enhance` below. */
  enhance?: boolean
  /** Downscale so the long edge is at most this many pixels. */
  maxLongEdgePx?: number
  /** JPEG quality for re-encodes. */
  quality?: number
}

const DEFAULT_QUALITY = 90

/**
 * Re-encode to JPEG with all metadata dropped.
 *
 * Phone photos carry GPS coordinates, device identifiers, and timestamps. If the
 * image is ever going to be stored, logged, or shown to anyone, this should happen
 * before any of that — not as a cleanup step afterwards.
 *
 * Rotation is baked in first, because stripping EXIF also strips the orientation
 * flag, and an unrotated image reads as a sideways form.
 */
export async function stripImage(input: Buffer, quality = DEFAULT_QUALITY): Promise<Buffer> {
  return sharp(input).rotate().jpeg({ quality, mozjpeg: true }).toBuffer()
}

/**
 * Mild contrast normalization and sharpening.
 *
 * Off by default, and worth measuring before enabling: on clean photographs it is
 * roughly neutral, and on already-sharp images the sharpen pass can amplify JPEG
 * ringing around thin printed rules into something the model reads as a stray mark.
 * It earns its place on dim or low-contrast captures.
 */
export async function enhance(input: Buffer, quality = DEFAULT_QUALITY): Promise<Buffer> {
  return sharp(input)
    .normalize()
    .modulate({ saturation: 1.06 })
    .sharpen({ sigma: 0.55, m1: 0.45, m2: 2.5 })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer()
}

/**
 * Downscale only genuinely oversized images.
 *
 * The default ceiling is high on purpose. Handwriting recognition degrades quickly
 * with resolution, and current vision models accept large inputs — so the usual
 * reflex of resizing to ~1500px costs accuracy for a saving you probably don't need.
 * Lower it deliberately, after measuring, if payload size is the actual constraint.
 */
export async function downscale(input: Buffer, maxLongEdgePx = 8192, quality = 88): Promise<Buffer> {
  const meta = await sharp(input).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (!w || !h) return input
  if (Math.max(w, h) <= maxLongEdgePx) return input

  return sharp(input)
    .resize(maxLongEdgePx, maxLongEdgePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer()
}

/** Strip, then optionally enhance and downscale, in that order. */
export async function prepareForVision(input: Buffer, opts: PrepOptions = {}): Promise<Buffer> {
  const quality = opts.quality ?? DEFAULT_QUALITY
  let buf = await stripImage(input, quality)
  if (opts.enhance) buf = await enhance(buf, quality)
  if (opts.maxLongEdgePx) buf = await downscale(buf, opts.maxLongEdgePx, quality)
  return buf
}

export interface ImageSize {
  width: number
  height: number
}

export async function imageSize(input: Buffer): Promise<ImageSize> {
  const meta = await sharp(input).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) throw new Error('imageSize: could not read image dimensions')
  return { width, height }
}
