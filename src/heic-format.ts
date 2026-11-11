const heifBrands = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** Also recognizes iPhone exports with an empty MIME type or a renamed extension. */
export async function isHeifPhoto(blob: Blob): Promise<boolean> {
  if (/^image\/hei[cf](?:-sequence)?$/i.test(blob.type)) return true;
  if ('name' in blob && typeof blob.name === 'string' && /\.hei[cf]$/i.test(blob.name)) return true;
  const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 16 || tag(4) !== 'ftyp') return false;
  const boxLength = new DataView(bytes.buffer).getUint32(0);
  if (boxLength < 16) return false;
  // avif/avis can also advertise mif1. Leave AVIF to the browser's normal decoder.
  if (tag(8) === 'avif' || tag(8) === 'avis') return false;
  if (heifBrands.has(tag(8))) return true;
  for (let offset = 16; offset + 4 <= Math.min(boxLength, bytes.length); offset += 4)
    if (heifBrands.has(tag(offset))) return true;
  return false;
}
