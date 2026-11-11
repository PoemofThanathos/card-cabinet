import { useEffect, useState } from 'react';
import { friendlyError } from './db';
import { croppedPreview } from './photo-display';
import { fileKey, type FileReference } from './bulk-entry';

export function PhotoPreview({
  source,
  file,
  label,
}: {
  source: FileReference;
  file?: File;
  label: string;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let created = '';
    setUrl('');
    setError('');
    if (file)
      void croppedPreview(file, 800)
        .then((photo) => {
          if (cancelled) return;
          created = URL.createObjectURL(photo);
          setUrl(created);
        })
        .catch((e) => {
          if (!cancelled) setError(friendlyError(e));
        });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file]);
  return (
    <figure>
      {url ? (
        <img
          src={url}
          alt={
            label === 'Front'
              ? 'Selected front photo'
              : label === 'Back'
                ? 'Selected back photo'
                : label
          }
        />
      ) : (
        <div className="bulk-photo-placeholder">
          {error ? 'Preview unavailable' : file ? 'Loading preview…' : 'Reselect photo'}
        </div>
      )}
      <figcaption>
        <strong>{label}</strong>
        <span>{source.name}</span>
      </figcaption>
      {error && <p className="notice warning">{error}</p>}
    </figure>
  );
}

export function PairPreview({
  sources,
  files,
}: {
  sources: [FileReference, FileReference];
  files: Map<string, File>;
}) {
  return (
    <div className="bulk-photo-pair">
      {sources.map((source, i) => (
        <PhotoPreview
          key={fileKey(source)}
          source={source}
          file={files.get(fileKey(source))}
          label={i ? 'Back' : 'Front'}
        />
      ))}
    </div>
  );
}
