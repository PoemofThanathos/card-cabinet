export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            'This browser could not read the image. Try a JPEG or PNG, or use Camera > Formats > Most Compatible on iPhone.',
          ),
        );
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export type Crop = { left: number; top: number; right: number; bottom: number };
export const fullCrop: Crop = { left: 0, top: 0, right: 100, bottom: 100 };
export async function transformPhoto(
  blob: Blob,
  rotation = 0,
  crop: Crop = fullCrop,
  maxEdge = 2560,
) {
  if (blob.size > 40 * 1024 * 1024)
    throw new Error('This image is larger than 40 MB. Choose a smaller image.');
  const image = await loadImage(blob);
  const iw = image.naturalWidth,
    ih = image.naturalHeight;
  if (iw * ih > 60000000)
    throw new Error('This image is too large to edit safely on a phone. Choose a smaller image.');
  const turned = rotation % 180 !== 0;
  const scale = Math.min(1, 3200 / Math.max(iw, ih));
  const stage = document.createElement('canvas');
  stage.width = Math.round((turned ? ih : iw) * scale);
  stage.height = Math.round((turned ? iw : ih) * scale);
  const s = stage.getContext('2d')!;
  s.fillStyle = '#fff';
  s.fillRect(0, 0, stage.width, stage.height);
  s.translate(stage.width / 2, stage.height / 2);
  s.rotate((rotation * Math.PI) / 180);
  s.drawImage(image, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
  const w = (stage.width * (crop.right - crop.left)) / 100,
    h = (stage.height * (crop.bottom - crop.top)) / 100;
  if (w < 100 || h < 100) throw new Error('Keep a crop at least 100 pixels wide and high.');
  const factor = Math.min(1, maxEdge / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.round(w * factor);
  out.height = Math.round(h * factor);
  out
    .getContext('2d')!
    .drawImage(
      stage,
      (stage.width * crop.left) / 100,
      (stage.height * crop.top) / 100,
      w,
      h,
      0,
      0,
      out.width,
      out.height,
    );
  const encoded = await new Promise<Blob>((resolve, reject) =>
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the photo.'))),
      'image/jpeg',
      0.92,
    ),
  );
  stage.width = stage.height = 1;
  out.width = out.height = 1;
  return encoded; // Canvas creates a new JPEG, without EXIF/GPS metadata.
}
export async function transmittedPhoto(blob: Blob) {
  const clean = await transformPhoto(blob, 0, fullCrop, 2560);
  if (clean.size > 2500000)
    throw new Error(
      'Photo is too detailed for the scan limit. Crop closer to the card and try again.',
    );
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(clean);
  });
}
