/**
 * Re-encode `assets/icon.ico` into the shapes macOS and Linux want, at build time.
 *
 * The .ico is the one committed icon artefact. Windows takes it directly (Bun embeds it in the
 * executable's resources), but a .app bundle needs a .icns and a .desktop entry needs a plain
 * image file, and neither format can be produced by copying bytes around: both want PNG data,
 * while a .ico stores its images as bottom-up BGRA DIBs. Deriving them here rather than
 * committing three hand-made files keeps a single source of truth — change the .ico and every
 * platform follows on the next build.
 *
 * Everything below is written against the file formats directly. The alternative is a native
 * image dependency (sharp, ImageMagick, `iconutil`), and `iconutil` in particular only exists
 * on macOS — which would mean the Linux and Windows CI runners could not cross-build a .app.
 * The formats involved are small and fully specified, so this is a few hundred lines rather
 * than a toolchain.
 */
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** CRC-32 (IEEE 802.3), which every PNG chunk carries in its last four bytes. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** length + type + data + CRC over (type + data). All lengths big-endian. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * Minimal 8-bit RGBA PNG encoder: one IDAT, filter type 0 on every scanline.
 *
 * Filtering exists to make the deflate stream compress better, and the adaptive heuristic that
 * chooses per-row filters is most of the complexity in a real encoder. These are app icons —
 * a few hundred KB uncompressed, embedded once — so the bytes saved are not worth the code.
 */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type 6 = truecolour with alpha
  // Bytes 10-12 stay zero: deflate compression, adaptive filtering, no interlace.

  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

/**
 * Convert one .ico image from its DIB form to RGBA, then to a PNG.
 *
 * Two quirks of the format, both inherited from Windows 3.x:
 *
 *   * `biHeight` is DOUBLE the real height. The colour rows are followed by a 1bpp AND mask
 *     from the era before icons had an alpha channel.
 *   * Rows are stored bottom-up and pixels are BGRA, so both are flipped on the way out.
 *
 * At 32bpp the alpha channel supersedes the AND mask and Windows ignores the mask — unless the
 * alpha channel is entirely zero, which some older converters emit, and which would otherwise
 * decode to a fully transparent image. That case falls back to the mask, matching what Windows
 * itself renders.
 */
function dibToPng(width: number, height: number, dib: Uint8Array): Uint8Array {
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength)
  const headerSize = view.getUint32(0, true)
  const bitCount = view.getUint16(14, true)
  const compression = view.getUint32(16, true)

  if (bitCount !== 32 || compression !== 0) {
    throw new Error(
      `${width}x${height} entry is ${bitCount}bpp, compression ${compression}; ` +
        'only uncompressed 32bpp entries are supported',
    )
  }

  const stride = width * 4
  const rgba = new Uint8Array(stride * height)
  let opaque = false

  for (let y = 0; y < height; y++) {
    let src = headerSize + (height - 1 - y) * stride
    let dst = y * stride
    for (let x = 0; x < width; x++) {
      rgba[dst] = dib[src + 2] // R <- B
      rgba[dst + 1] = dib[src + 1] // G
      rgba[dst + 2] = dib[src] // B <- R
      rgba[dst + 3] = dib[src + 3]
      opaque ||= dib[src + 3] !== 0
      src += 4
      dst += 4
    }
  }

  if (!opaque) applyAndMask(width, height, dib, headerSize + stride * height, rgba)

  return encodePng(width, height, rgba)
}

/**
 * Rebuild the alpha channel from the 1bpp AND mask. A set bit means transparent.
 *
 * Mask rows are bottom-up like the colour rows and padded to a 4-byte boundary. A truncated or
 * absent mask leaves the image fully opaque, which is the right answer for an icon whose alpha
 * channel is blank: a visible square beats an invisible one.
 */
function applyAndMask(
  width: number,
  height: number,
  dib: Uint8Array,
  maskStart: number,
  rgba: Uint8Array,
): void {
  const maskStride = ((width + 31) >> 5) << 2

  if (maskStart + maskStride * height > dib.length) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0xff
    return
  }

  for (let y = 0; y < height; y++) {
    const row = maskStart + (height - 1 - y) * maskStride
    for (let x = 0; x < width; x++) {
      const transparent = (dib[row + (x >> 3)] >> (7 - (x & 7))) & 1
      rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 0xff
    }
  }
}

/**
 * Read every square image in a .ico and return it as PNG bytes, keyed by edge length.
 *
 * Entries already stored as PNG are passed through untouched — that is how most converters
 * write the 256x256 image, even though the one in this repo is a DIB like the rest.
 */
export async function readIcoAsPngs(icoPath: string): Promise<Map<number, Uint8Array>> {
  const ico = new Uint8Array(await Bun.file(icoPath).arrayBuffer())
  const dir = new DataView(ico.buffer, ico.byteOffset, ico.byteLength)

  if (ico.length < 6 || dir.getUint16(0, true) !== 0 || dir.getUint16(2, true) !== 1) {
    throw new Error(`${icoPath} is not a Windows icon file`)
  }

  const images = new Map<number, Uint8Array>()

  for (let i = 0; i < dir.getUint16(4, true); i++) {
    const entry = 6 + i * 16
    // The width and height fields are one byte each, so 256 is stored as 0.
    const width = ico[entry] || 256
    const height = ico[entry + 1] || 256
    if (width !== height) continue // both .icns and .desktop want squares

    const offset = dir.getUint32(entry + 12, true)
    const data = ico.subarray(offset, offset + dir.getUint32(entry + 8, true))
    const alreadyPng = PNG_SIGNATURE.every((byte, at) => data[at] === byte)

    images.set(width, alreadyPng ? data : dibToPng(width, height, data))
  }

  if (images.size === 0) throw new Error(`${icoPath} contains no square images`)

  return images
}

/** The biggest image in the set — what a .desktop entry should point `Icon=` at. */
export function largestPng(images: Map<number, Uint8Array>): Uint8Array {
  const png = images.get(Math.max(...images.keys()))
  if (!png) throw new Error('no images to choose from')
  return png
}

/**
 * The OSType codes `iconutil` emits for a .iconset, which is the mapping macOS has shipped
 * since 10.7. Each is a pixel size; the @2x variants are the same pixels filed under a second
 * code, because Finder picks by code rather than by measuring. All of these take PNG payloads.
 *
 * A .ico carries no 512x512, so ic09/ic10/ic14 are absent and macOS falls back to the largest
 * code present. The 48x48 entry has no home here — ICNS has never had a 48 slot.
 */
const ICNS_TYPES: Array<[size: number, type: string]> = [
  [16, 'icp4'], // 16x16
  [32, 'ic11'], // 16x16@2x
  [32, 'icp5'], // 32x32
  [64, 'ic12'], // 32x32@2x
  [128, 'ic07'], // 128x128
  [256, 'ic13'], // 128x128@2x
  [256, 'ic08'], // 256x256
]

/**
 * Pack the images into an .icns container: the magic `icns`, the total byte length, then one
 * 8-byte header per image (OSType, then a length that INCLUDES those 8 bytes). Big-endian
 * throughout — the format predates the Intel transition.
 */
export function buildIcns(images: Map<number, Uint8Array>): Uint8Array {
  const entries: Uint8Array[] = []

  for (const [size, type] of ICNS_TYPES) {
    const png = images.get(size)
    if (!png) continue

    const entry = new Uint8Array(8 + png.length)
    for (let i = 0; i < 4; i++) entry[i] = type.charCodeAt(i)
    new DataView(entry.buffer).setUint32(4, entry.length)
    entry.set(png, 8)
    entries.push(entry)
  }

  if (entries.length === 0) {
    throw new Error(`no icon size matched an ICNS slot (have ${[...images.keys()].join(', ')})`)
  }

  const body = concat(entries)
  const out = new Uint8Array(8 + body.length)
  out.set([0x69, 0x63, 0x6e, 0x73]) // 'icns'
  new DataView(out.buffer).setUint32(4, out.length)
  out.set(body, 8)
  return out
}
