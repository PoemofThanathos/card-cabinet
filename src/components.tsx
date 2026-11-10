import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { X, ImageOff, RotateCw, Camera, Upload, Check, ScanLine } from 'lucide-react';
import { db, makePhoto, friendlyError, photoBlob } from './db';
import { transformPhoto, fullCrop, type Crop } from './photos';

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PhotoView({
  hash,
  alt,
  className = '',
}: {
  hash: string | null;
  alt: string;
  className?: string;
}) {
  const photo = useLiveQuery(() => (hash ? db.photos.get(hash) : undefined), [hash]);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!photo) {
      setUrl('');
      return;
    }
    const u = URL.createObjectURL(photoBlob(photo));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);
  return url ? (
    <img className={className} src={url} alt={alt} />
  ) : (
    <div className={'photo-missing ' + className}>
      <ImageOff size={28} />
      <span>{hash ? 'Photo missing here' : 'No photo yet'}</span>
    </div>
  );
}
export function PhotoPicker({
  side,
  hash,
  onChange,
  onError,
}: {
  side: 'front' | 'back';
  hash: string | null;
  onChange: (hash: string | null) => void;
  onError: (message: string) => void;
}) {
  const [source, setSource] = useState<Blob | null>(null),
    [rotation, setRotation] = useState(0),
    [crop, setCrop] = useState<Crop>(fullCrop),
    [preview, setPreview] = useState(''),
    [busy, setBusy] = useState(false),
    [editError, setEditError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null),
    cameraRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!source) return;
    let cancelled = false,
      u = '';
    void transformPhoto(source, rotation, fullCrop, 1000)
      .then((b) => {
        if (cancelled) return;
        u = URL.createObjectURL(b);
        setPreview(u);
      })
      .catch((e) => {
        if (cancelled) return;
        setEditError(friendlyError(e));
        onError(friendlyError(e));
      });
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [source, rotation]);
  function choose(file?: File) {
    if (!file) return;
    setEditError('');
    setPreview('');
    setSource(file);
    setRotation(0);
    setCrop(fullCrop);
  }
  async function usePhoto() {
    if (!source) return;
    setBusy(true);
    try {
      const blob = await transformPhoto(source, rotation, crop);
      const photo = await makePhoto(blob);
      await db.photos.put(photo);
      onChange(photo.hash);
      setSource(null);
    } catch (e) {
      setEditError(friendlyError(e));
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="photo-picker">
      <div className="side-label">
        {side}
        <span>Local photo</span>
      </div>
      <PhotoView hash={hash} alt={side + ' of card'} />
      <div className="photo-actions">
        <button type="button" onClick={() => cameraRef.current?.click()}>
          <Camera size={16} /> {hash ? 'Retake' : 'Camera'}
        </button>
        <button type="button" onClick={() => fileRef.current?.click()}>
          <Upload size={16} /> Import
        </button>
        {hash && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={'Remove ' + side + ' photo'}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {source && (
        <Modal
          title={'Adjust ' + side + ' photo'}
          onClose={() => {
            if (!busy) setSource(null);
          }}
        >
          {editError && (
            <p className="notice warning" role="alert">
              {editError}
            </p>
          )}
          <p className="muted">
            Rotate first, then move the crop edges. Keep small print in frame.
          </p>
          <div className="crop-preview">
            {preview && <img src={preview} alt="Photo before crop" />}
            <div
              className="crop-box"
              style={{
                left: crop.left + '%',
                top: crop.top + '%',
                right: 100 - crop.right + '%',
                bottom: 100 - crop.bottom + '%',
              }}
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRotation((rotation + 90) % 360);
              setCrop(fullCrop);
            }}
          >
            <RotateCw size={16} /> Rotate 90°
          </button>
          <div className="crop-sliders">
            {(['left', 'top', 'right', 'bottom'] as const).map((edge) => (
              <label key={edge}>
                {edge}
                <input
                  type="range"
                  disabled={busy}
                  min={edge === 'right' ? crop.left + 10 : edge === 'bottom' ? crop.top + 10 : 0}
                  max={edge === 'left' ? crop.right - 10 : edge === 'top' ? crop.bottom - 10 : 100}
                  value={crop[edge]}
                  onChange={(e) => setCrop({ ...crop, [edge]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="modal-footer">
            <button
              disabled={busy}
              onClick={() => {
                setCrop(fullCrop);
                setRotation(0);
              }}
            >
              Reset
            </button>
            <button className="primary" disabled={busy} onClick={() => void usePhoto()}>
              <Check size={17} />
              {busy ? 'Saving photo…' : 'Use photo'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export const ScanIcon = ScanLine;
