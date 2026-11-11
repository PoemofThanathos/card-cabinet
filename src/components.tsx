import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { X, ImageOff, RotateCw, Camera, Upload, Check, ScanLine } from 'lucide-react';
import { db, makePhoto, friendlyError, photoBlob } from './db';
import { transformPhoto, fullCrop, type Crop } from './photos';
import { displayedPhoto, changePhotoDisplay, defaultDisplay, rotateDisplay } from './photo-display';
import type { Photo, PhotoDisplay } from './db';

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
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
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
  editable = false,
}: {
  hash: string | null;
  alt: string;
  className?: string;
  editable?: boolean;
}) {
  const element = useRef<HTMLImageElement | HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(editable || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible, hash]);
  const data = useLiveQuery(
    async () =>
      hash && visible
        ? { photo: await db.photos.get(hash), display: await db.photoDisplays.get(hash) }
        : undefined,
    [hash, visible],
  );
  const photo = data?.photo;
  const [adjust, setAdjust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const originalUrl = useRef('');
  useEffect(() => {
    if (!photo || photo.hash !== hash) {
      setUrl('');
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    const u = URL.createObjectURL(photoBlob(photo));
    originalUrl.current = u;
    urls.push(u);
    setUrl(u);
    void displayedPhoto(photo, data?.display).then((blob) => {
      if (cancelled) return;
      const next = URL.createObjectURL(blob);
      urls.push(next);
      setUrl(next);
    });
    return () => {
      cancelled = true;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [photo, data?.display, hash]);
  async function change(mode: 'rotate' | 'auto' | 'original') {
    if (!photo) return;
    setBusy(true);
    setError('');
    try {
      const current = data?.display ?? defaultDisplay;
      await changePhotoDisplay(
        photo,
        mode === 'rotate' ? rotateDisplay(current) : { ...defaultDisplay, mode },
      );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  function failedPreview() {
    if (url === originalUrl.current) {
      setError('This photo could not be read. Replace it with a JPEG or PNG.');
      return;
    }
    setUrl(originalUrl.current);
    // A damaged derived cache must never hide a readable saved photo.
    if (photo && data?.display?.bytes) {
      const revision = data.display.updatedAt;
      void db
        .transaction('rw', db.photoDisplays, async () => {
          const current = await db.photoDisplays.get(photo.hash);
          if (current?.updatedAt === revision) {
            delete current.bytes;
            await db.photoDisplays.put(current);
          }
        })
        .catch(() => {});
    }
  }
  return (
    <>
      {url ? (
        <img
          ref={(node) => {
            element.current = node;
          }}
          className={className}
          src={url}
          alt={alt}
          data-preview-mode={data?.display?.mode ?? 'loading'}
          onError={failedPreview}
        />
      ) : (
        <div
          ref={(node) => {
            element.current = node;
          }}
          className={'photo-missing ' + className}
        >
          <ImageOff size={28} />
          <span>
            {hash
              ? !visible || data === undefined
                ? 'Loading photo…'
                : 'Photo missing here'
              : 'No photo yet'}
          </span>
        </div>
      )}
      {editable && photo && (
        <div className="photo-view-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void change('rotate')}
            aria-label={'Rotate ' + alt}
          >
            <RotateCw size={15} /> Rotate
          </button>
          <button type="button" disabled={busy} onClick={() => setAdjust(true)}>
            Adjust crop
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void change(data?.display?.mode === 'original' ? 'auto' : 'original')}
          >
            {data?.display?.mode === 'original' ? 'Auto crop' : 'Original'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {adjust && photo && (
        <PhotoDisplayAdjust photo={photo} saved={data?.display} onClose={() => setAdjust(false)} />
      )}
    </>
  );
}

function PhotoDisplayAdjust({
  photo,
  saved,
  onClose,
}: {
  photo: Photo;
  saved?: PhotoDisplay;
  onClose: () => void;
}) {
  const [rotation, setRotation] = useState(saved?.rotation ?? 0);
  const [crop, setCrop] = useState<Crop>(saved?.mode === 'manual' ? saved.crop : fullCrop);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let created = '';
    void transformPhoto(photoBlob(photo), rotation, fullCrop, 1000)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [photo, rotation]);
  async function save(mode: 'manual' | 'auto') {
    setBusy(true);
    setError('');
    try {
      await changePhotoDisplay(photo, { mode, rotation, crop: mode === 'auto' ? fullCrop : crop });
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Adjust card photo"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="small muted">
        Crop the preview. The original photo is kept for identification and backups.
      </p>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      <div className="crop-preview">
        {url && <img src={url} alt="Original photo for cropping" />}
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
        <button disabled={busy} onClick={() => void save('auto')}>
          Auto crop
        </button>
        <button className="primary" disabled={busy} onClick={() => void save('manual')}>
          {busy ? 'Saving…' : 'Save crop'}
        </button>
      </div>
    </Modal>
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
      <PhotoView hash={hash} alt={side + ' of card'} editable />
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
