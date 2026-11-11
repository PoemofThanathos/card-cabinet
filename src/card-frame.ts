export type FramePoint = { x: number; y: number };
export type CardFrame = {
  /** Clockwise corners, starting at the upper left, in source pixels. */
  corners: [FramePoint, FramePoint, FramePoint, FramePoint];
  confidence: number;
};
type Line = { a: number; b: number; rho: number; score: number; boundary?: boolean };
const distance = (a: FramePoint, b: FramePoint) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

function intersection(a: Line, b: Line): FramePoint {
  const det = a.a * b.b - b.a * a.b;
  return { x: (a.rho * b.b - b.rho * a.b) / det, y: (a.a * b.rho - b.a * a.rho) / det };
}

/** Detect a mostly front-on card. Uncertain images are deliberately left uncropped. */
export function detectCardFrame(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): CardFrame | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 80 ||
    height < 80 ||
    width > 600 ||
    height > 600 ||
    pixels.length !== width * height * 4
  )
    return null;
  const count = width * height;
  const smooth = new Float32Array(count * 3);
  const gx = new Float32Array(count),
    gy = new Float32Array(count),
    magnitude = new Float32Array(count);
  // A small blur suppresses table texture while retaining continuous card edges.
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let yy = -2; yy <= 2; yy++)
          for (let xx = -2; xx <= 2; xx++) sum += pixels[((y + yy) * width + x + xx) * 4 + c];
        smooth[(y * width + x) * 3 + c] = sum / 25;
      }
    }
  const histogram = new Uint32Array(256);
  for (let y = 3; y < height - 3; y++)
    for (let x = 3; x < width - 3; x++) {
      const i = y * width + x;
      for (let c = 0; c < 3; c++) {
        const dx = smooth[(i + 1) * 3 + c] - smooth[(i - 1) * 3 + c];
        const dy = smooth[(i + width) * 3 + c] - smooth[(i - width) * 3 + c];
        const m = Math.hypot(dx, dy);
        if (m > magnitude[i]) {
          gx[i] = dx;
          gy[i] = dy;
          magnitude[i] = m;
        }
      }
      histogram[Math.min(255, Math.round(magnitude[i]))]++;
    }
  let cumulative = 0,
    quantile = 0;
  while (quantile < 255 && cumulative < count * 0.83) cumulative += histogram[quantile++];
  const threshold = Math.max(6, quantile * 0.65);
  const diagonal = Math.ceil(Math.hypot(width, height));
  function lines(horizontal: boolean): Line[] {
    const candidates: Line[] = [];
    for (let angle = -16; angle <= 16; angle += 2) {
      const radians = (((horizontal ? 90 : 0) + angle) * Math.PI) / 180;
      const a = Math.cos(radians),
        b = Math.sin(radians);
      const votes = new Float32Array(diagonal * 2 + 1);
      for (let y = 3; y < height - 3; y++)
        for (let x = 3; x < width - 3; x++) {
          const i = y * width + x,
            m = magnitude[i];
          if (m < threshold || Math.abs(gx[i] * a + gy[i] * b) / m < 0.8) continue;
          const rho = Math.round(a * x + b * y) + diagonal;
          votes[rho] += Math.min(3, m / threshold);
        }
      for (let i = 3; i < votes.length - 3; i++) {
        const score = votes[i - 1] + votes[i] + votes[i + 1];
        if (score < Math.min(width, height) * 0.14) continue;
        if (
          score < votes[i - 2] + votes[i - 1] + votes[i] ||
          score < votes[i] + votes[i + 1] + votes[i + 2]
        )
          continue;
        candidates.push({ a, b, rho: i - diagonal, score });
      }
    }
    const selected: Line[] = [];
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
      const center = horizontal
        ? { x: width / 2, y: (candidate.rho - (candidate.a * width) / 2) / candidate.b }
        : { x: (candidate.rho - (candidate.b * height) / 2) / candidate.a, y: height / 2 };
      if (
        selected.some(
          (line) =>
            Math.abs(line.a * center.x + line.b * center.y - line.rho) < 8 &&
            line.a * candidate.a + line.b * candidate.b > 0.99,
        )
      )
        continue;
      selected.push(candidate);
      if (selected.length === 24) break;
    }
    selected.push(
      horizontal
        ? { a: 0, b: 1, rho: 1, score: 0, boundary: true }
        : { a: 1, b: 0, rho: 1, score: 0, boundary: true },
    );
    selected.push(
      horizontal
        ? { a: 0, b: 1, rho: height - 2, score: 0, boundary: true }
        : { a: 1, b: 0, rho: width - 2, score: 0, boundary: true },
    );
    return selected;
  }
  const horizontal = lines(true),
    vertical = lines(false);
  function support(a: FramePoint, b: FramePoint, line: Line) {
    if (line.boundary) {
      let sr = 0,
        sg = 0,
        squares = 0,
        n = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const x = clamp(Math.round(a.x + (b.x - a.x) * t), 0, width - 1);
        const y = clamp(Math.round(a.y + (b.y - a.y) * t), 0, height - 1);
        const i = (y * width + x) * 4,
          sum = pixels[i] + pixels[i + 1] + pixels[i + 2] + 1;
        const r = pixels[i] / sum,
          g = pixels[i + 1] / sum;
        sr += r;
        sg += g;
        squares += r * r + g * g;
        n++;
      }
      const variance = squares / n - (sr / n) ** 2 - (sg / n) ** 2;
      return variance > 0.0005 ? 0.92 : 0;
    }
    let good = 0,
      total = 0;
    const steps = Math.ceil(distance(a, b) / 3);
    for (let n = 1; n < steps; n++) {
      const t = n / steps;
      const x = a.x + (b.x - a.x) * t,
        y = a.y + (b.y - a.y) * t;
      let best = 0;
      for (let offset = -3; offset <= 3; offset++) {
        const xx = Math.round(x + line.a * offset),
          yy = Math.round(y + line.b * offset);
        if (xx < 3 || yy < 3 || xx >= width - 3 || yy >= height - 3) continue;
        const i = yy * width + xx;
        best = Math.max(best, Math.abs(gx[i] * line.a + gy[i] * line.b));
      }
      good += best >= threshold * 0.65 ? 1 : 0;
      total++;
    }
    return total ? good / total : 0;
  }
  let best: CardFrame | null = null,
    bestScore = 0;
  for (let hi = 0; hi < horizontal.length; hi++)
    for (let hj = hi + 1; hj < horizontal.length; hj++) {
      let top = horizontal[hi],
        bottom = horizontal[hj];
      if (top.a * bottom.a + top.b * bottom.b < 0.99) continue;
      if (
        (top.rho - (top.a * width) / 2) / top.b >
        (bottom.rho - (bottom.a * width) / 2) / bottom.b
      )
        [top, bottom] = [bottom, top];
      if (bottom.rho / bottom.b - top.rho / top.b < height * 0.2) continue;
      for (let vi = 0; vi < vertical.length; vi++)
        for (let vj = vi + 1; vj < vertical.length; vj++) {
          let left = vertical[vi],
            right = vertical[vj];
          if (left.a * right.a + left.b * right.b < 0.99) continue;
          if (
            (left.rho - (left.b * height) / 2) / left.a >
            (right.rho - (right.b * height) / 2) / right.a
          )
            [left, right] = [right, left];
          const edges = [top, right, bottom, left];
          if (edges.filter((line) => line.boundary).length > 1) continue;
          if (
            edges.some(
              (line, i) =>
                Math.abs(line.a * edges[(i + 1) % 4].a + line.b * edges[(i + 1) % 4].b) > 0.24,
            )
          )
            continue;
          const corners: CardFrame['corners'] = [
            intersection(top, left),
            intersection(top, right),
            intersection(bottom, right),
            intersection(bottom, left),
          ];
          if (corners.some((p) => p.x < -2 || p.x > width + 1 || p.y < -2 || p.y > height + 1))
            continue;
          const [tl, tr, br, bl] = corners;
          const w = (distance(tl, tr) + distance(bl, br)) / 2,
            h = (distance(tl, bl) + distance(tr, br)) / 2;
          if (
            w < width * 0.25 ||
            h < height * 0.2 ||
            distance(tl, tr) / distance(bl, br) < 0.72 ||
            distance(tl, tr) / distance(bl, br) > 1.38
          )
            continue;
          const aspect = Math.max(w, h) / Math.min(w, h);
          if (aspect < 1.18 || aspect > 1.65) continue;
          const area =
            Math.abs(
              corners.reduce(
                (sum, p, i) => sum + p.x * corners[(i + 1) % 4].y - p.y * corners[(i + 1) % 4].x,
                0,
              ),
            ) / 2;
          const coverage = area / count;
          if (coverage < 0.18 || coverage > 0.96) continue;
          const sides = [
            support(tl, tr, top),
            support(tr, br, right),
            support(bl, br, bottom),
            support(tl, bl, left),
          ];
          if (
            edges.some(
              (line, i) => !line.boundary && edges.some((edge) => edge.boundary) && sides[i] < 0.7,
            )
          )
            continue;
          if (Math.min(...sides) < 0.72 || sides.filter((s) => s > 0.85).length < 3) continue;
          const confidence = sides.reduce((sum, v) => sum + v, 0) / 4;
          const lineStrength =
            edges.reduce(
              (sum, line, i) =>
                sum +
                (line.boundary
                  ? 0.8
                  : Math.min(1, line.score / (distance(corners[i], corners[(i + 1) % 4]) * 6))),
              0,
            ) / 4;
          const skew =
            Math.acos(clamp(top.a * bottom.a + top.b * bottom.b, -1, 1)) +
            Math.acos(clamp(left.a * right.a + left.b * right.b, -1, 1));
          const score =
            confidence +
            coverage * 0.6 +
            lineStrength * 0.5 -
            skew * 0.9 -
            Math.abs(Math.log(aspect / 1.4)) * 0.2;
          if (score > bestScore) {
            bestScore = score;
            best = {
              corners: corners.map((p) => ({
                x: clamp(p.x, 0, width - 1),
                y: clamp(p.y, 0, height - 1),
              })) as CardFrame['corners'],
              confidence,
            };
          }
        }
    }
  if (!best) return null;
  // Leave a narrow margin so rounded edges and print at the border stay visible.
  const cx = best.corners.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = best.corners.reduce((sum, p) => sum + p.y, 0) / 4;
  best.corners = best.corners.map((p) => ({
    x: clamp(cx + (p.x - cx) * 1.025, 0, width - 1),
    y: clamp(cy + (p.y - cy) * 1.025, 0, height - 1),
  })) as CardFrame['corners'];
  return best;
}

let pending: Promise<unknown> = Promise.resolve();
/** Generate a local display copy. The supplied photo and its orientation are preserved. */
export function frameCardPhoto(blob: Blob): Promise<Blob> {
  const result = pending.then(() => frameOne(blob)).catch(() => blob);
  pending = result;
  return result;
}
async function frameOne(blob: Blob): Promise<Blob> {
  if (blob.size > 40 * 1024 * 1024) return blob;
  const url = URL.createObjectURL(blob),
    image = new Image();
  const analysis = document.createElement('canvas'),
    source = document.createElement('canvas'),
    output = document.createElement('canvas');
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = url;
    });
    const iw = image.naturalWidth,
      ih = image.naturalHeight;
    if (!iw || !ih || iw * ih > 60_000_000) return blob;
    const scale = Math.min(1, 600 / Math.max(iw, ih));
    analysis.width = Math.round(iw * scale);
    analysis.height = Math.round(ih * scale);
    const ctx = analysis.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, analysis.width, analysis.height);
    const frame = detectCardFrame(
      ctx.getImageData(0, 0, analysis.width, analysis.height).data,
      analysis.width,
      analysis.height,
    );
    if (!frame) return blob;
    const sourceScale = Math.min(1, 2400 / Math.max(iw, ih));
    source.width = Math.round(iw * sourceScale);
    source.height = Math.round(ih * sourceScale);
    const s = source.getContext('2d', { willReadFrequently: true })!;
    s.drawImage(image, 0, 0, source.width, source.height);
    const points = frame.corners.map((p) => ({
      x: (p.x * source.width) / analysis.width,
      y: (p.y * source.height) / analysis.height,
    }));
    const [p0, p1, p2, p3] = points;
    const w = (distance(p0, p1) + distance(p3, p2)) / 2,
      h = (distance(p0, p3) + distance(p1, p2)) / 2;
    const size = Math.min(1, 1600 / Math.max(w, h));
    output.width = Math.max(1, Math.round(w * size));
    output.height = Math.max(1, Math.round(h * size));
    const dx1 = p1.x - p2.x,
      dx2 = p3.x - p2.x,
      dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y,
      dy2 = p3.y - p2.y,
      dy3 = p0.y - p1.y + p2.y - p3.y;
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / det,
      hh = (dx1 * dy3 - dx3 * dy1) / det;
    const a = p1.x - p0.x + g * p1.x,
      b = p3.x - p0.x + hh * p3.x;
    const d = p1.y - p0.y + g * p1.y,
      e = p3.y - p0.y + hh * p3.y;
    const input = s.getImageData(0, 0, source.width, source.height).data;
    const o = output.getContext('2d')!,
      result = o.createImageData(output.width, output.height);
    for (let y = 0; y < output.height; y++)
      for (let x = 0; x < output.width; x++) {
        const u = x / Math.max(1, output.width - 1),
          v = y / Math.max(1, output.height - 1),
          den = g * u + hh * v + 1;
        const sx = clamp((a * u + b * v + p0.x) / den, 0, source.width - 1.001),
          sy = clamp((d * u + e * v + p0.y) / den, 0, source.height - 1.001);
        const xx = Math.floor(sx),
          yy = Math.floor(sy),
          fx = sx - xx,
          fy = sy - yy;
        const ii = (yy * source.width + xx) * 4,
          oi = (y * output.width + x) * 4;
        for (let c = 0; c < 3; c++)
          result.data[oi + c] =
            input[ii + c] * (1 - fx) * (1 - fy) +
            input[ii + 4 + c] * fx * (1 - fy) +
            input[ii + source.width * 4 + c] * (1 - fx) * fy +
            input[ii + source.width * 4 + 4 + c] * fx * fy;
        result.data[oi + 3] = 255;
      }
    o.putImageData(result, 0, 0);
    return await new Promise<Blob>((resolve) =>
      output.toBlob((value) => resolve(value ?? blob), 'image/jpeg', 0.92),
    );
  } finally {
    URL.revokeObjectURL(url);
    image.src = '';
    analysis.width =
      analysis.height =
      source.width =
      source.height =
      output.width =
      output.height =
        1;
  }
}
