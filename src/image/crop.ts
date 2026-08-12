/**
 * Cropping — normalized rects in, JPEG buffers out.
 */

import sharp from 'sharp'
import type { NormRect } from '../formspec/types.js'
import { imageSize } from './prep.js'

export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a normalized rect onto integer pixel coordinates, clamped inside the image.
 *
 * Floor the origin and ceil the size so a rect never loses a boundary pixel to
 * rounding — over-including a pixel is free, and under-including one can clip the
 * top of a digit.
 */
export function normRectToPixels(rect: NormRect, width: number, height: number): PixelRect {
  let left = Math.floor(rect.x * width)
  let top = Math.floor(rect.y * height)
  let w = Math.ceil(rect.w * width)
  let h = Math.ceil(rect.h * height)

  left = Math.max(0, Math.min(left, Math.max(0, width - 1)))
  top = Math.max(0, Math.min(top, Math.max(0, height - 1)))
  w = Math.min(Math.max(1, w), width - left)
  h = Math.min(Math.max(1, h), height - top)

  return { left, top, width: w, height: h }
}

/** Extract a pixel region as a JPEG. */
export async function cropPixels(input: Buffer, rect: PixelRect, quality = 92): Promise<Buffer> {
  return sharp(input).extract(rect).jpeg({ quality, mozjpeg: true }).toBuffer()
}

/**
 * Crop to a normalized rect. Reads image dimensions on every call — when cropping
 * many sections from one image, read the size once and use `cropPixels` in the loop.
 */
export async function cropNormRect(input: Buffer, rect: NormRect, quality = 92): Promise<Buffer> {
  const { width, height } = await imageSize(input)
  return cropPixels(input, normRectToPixels(rect, width, height), quality)
}
