import { expect, it } from 'vitest';
import { detectCardFrame, frameCardPhoto, type FramePoint } from '../src/card-frame';

function fixture(width: number, height: number, corners: FramePoint[], texture = false) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let random = 913;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = corners.every((a, i) => {
        const b = corners[(i + 1) % corners.length];
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0;
      });
      random = (random * 1664525 + 1013904223) >>> 0;
      const noise = texture ? (random % 27) - 13 : 0;
      const i = (y * width + x) * 4;
      const color = inside
        ? [215 + noise, 211 + noise, 225 + noise]
        : [84 + noise, 69 + noise, 42 + noise];
      pixels.set([...color, 255], i);
      // A contrasting printed panel must not replace the outer card frame.
      if (inside && x > width * 0.32 && x < width * 0.65 && y > height * 0.3 && y < height * 0.65)
        pixels.set([53, 98, 133, 255], i);
    }
  return pixels;
}

it.each([
  {
    name: 'portrait',
    width: 360,
    height: 480,
    corners: [
      { x: 70, y: 65 },
      { x: 285, y: 65 },
      { x: 285, y: 366 },
      { x: 70, y: 366 },
    ],
  },
  {
    name: 'landscape with texture',
    width: 450,
    height: 600,
    corners: [
      { x: 35, y: 90 },
      { x: 425, y: 112 },
      { x: 410, y: 385 },
      { x: 25, y: 365 },
    ],
  },
])('finds the outer $name card and keeps its orientation', ({ width, height, corners }) => {
  const result = detectCardFrame(fixture(width, height, corners, true), width, height);
  expect(result).not.toBeNull();
  result!.corners.forEach((point, i) => {
    expect(Math.abs(point.x - corners[i].x)).toBeLessThan(13);
    expect(Math.abs(point.y - corners[i].y)).toBeLessThan(13);
  });
  expect(result!.confidence).toBeGreaterThan(0.8);
});

it('does not crop a uniform photo', () => {
  const pixels = new Uint8ClampedArray(400 * 500 * 4).fill(128);
  expect(detectCardFrame(pixels, 400, 500)).toBeNull();
});

it('leaves small objects and square objects uncropped', () => {
  const small = [
    { x: 150, y: 170 },
    { x: 220, y: 170 },
    { x: 220, y: 270 },
    { x: 150, y: 270 },
  ];
  const square = [
    { x: 75, y: 125 },
    { x: 325, y: 125 },
    { x: 325, y: 375 },
    { x: 75, y: 375 },
  ];
  expect(detectCardFrame(fixture(400, 500, small), 400, 500)).toBeNull();
  expect(detectCardFrame(fixture(400, 500, square), 400, 500)).toBeNull();
});

it('rejects invalid or oversized pixel buffers before allocating analysis arrays', () => {
  expect(detectCardFrame(new Uint8Array(), 400, 500)).toBeNull();
  expect(detectCardFrame(new Uint8Array(601 * 600 * 4), 601, 600)).toBeNull();
});

it('returns the original when browser decoding is unavailable', async () => {
  const blob = new Blob(['unreadable'], { type: 'image/jpeg' });
  expect(await frameCardPhoto(blob)).toBe(blob);
  expect(await frameCardPhoto(blob)).toBe(blob);
});
