// Minimal image dimension reader — parses just enough of each container's header to
// get width/height, so adding photos doesn't need a native image dependency.
// Supported: JPEG, PNG, GIF, WebP, HEIC/HEIF/AVIF (ispe box).

import { open } from 'node:fs/promises'

// Enough for JPEG segment walking on files with big EXIF/ICC blocks up front.
const HEAD_BYTES = 512 * 1024

async function readHead(file) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES))
    await fh.read(buf, 0, buf.length, 0)
    return buf
  } finally {
    await fh.close()
  }
}

function png(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gif(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'GIF') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function webp(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF') return null
  if (buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    const dim = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
    return { width: dim(24) + 1, height: dim(27) + 1 }
  }
  return null
}

function jpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++ // resync past padding / stray bytes
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null // start of scan: no frame header found
    const length = buf.readUInt16BE(i + 2)
    // SOF0-15, minus the DHT/JPG/DAC markers that share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    i += 2 + length
  }
  return null
}

// HEIC/AVIF: find the `ispe` (image spatial extents) box. The first one belongs to the
// primary item in every file Apple/DJI cameras produce.
function heif(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return null
  const at = buf.indexOf('ispe', 0, 'latin1')
  if (at < 0 || at + 16 > buf.length) return null
  return { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) }
}

/** Returns { width, height }, or null if the format/header isn't recognized. */
export async function imageSize(file) {
  const buf = await readHead(file)
  for (const parse of [png, gif, webp, jpeg, heif]) {
    const size = parse(buf)
    if (size?.width && size?.height) return size
  }
  return null
}
