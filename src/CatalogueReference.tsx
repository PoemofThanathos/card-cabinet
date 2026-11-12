import { useEffect, useRef, useState } from 'react';
import type { Card } from './model';
import {
  catalogueIdentity,
  identityFingerprint,
  advanceIdentity,
  isCurrentLookup,
  type CatalogueResult,
} from './catalogue';
import { findCatalogue } from './ai';

export function CatalogueReference({ fields }: { fields: Card['fields'] }) {
  const identity = catalogueIdentity(fields),
    fingerprint = identityFingerprint(identity);
  const current = useRef({ fingerprint, generation: 0 });
  current.current = advanceIdentity(current.current, fingerprint);
  const [result, setResult] = useState<CatalogueResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [broken, setBroken] = useState<string[]>([]);
  useEffect(() => {
    setResult(null);
    setError('');
    setBusy(false);
    setBroken([]);
  }, [fingerprint]);
  async function lookup() {
    const started = current.current.generation;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const found = await findCatalogue(identity);
      if (isCurrentLookup(current.current, started)) setResult(found);
    } catch (e) {
      if (isCurrentLookup(current.current, started))
        setError(e instanceof Error ? e.message : 'Catalogue lookup failed.');
    } finally {
      if (isCurrentLookup(current.current, started)) setBusy(false);
    }
  }
  return (
    <section className="catalogue-reference" aria-label="Catalogue reference">
      <h3>Catalogue reference</h3>
      <p className="small muted">
        Searches public sources using the card identity. This uses one identification attempt.
      </p>
      <button
        type="button"
        disabled={busy || !(identity.name.trim() || identity.japaneseName.trim())}
        onClick={() => void lookup()}
      >
        {busy ? 'Searching…' : 'Find catalogue image'}
      </button>
      {!(identity.name.trim() || identity.japaneseName.trim()) && (
        <p className="small muted">Add a player or character name to search.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {result && !result.candidates.length && <p>No matching catalogue image or source found.</p>}
      {result?.candidates.map((c) => (
        <div key={c.sourceUrl} className="catalogue-candidate">
          <p>
            <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
              {c.title || 'Catalogue source'}
            </a>{' '}
            ·{' '}
            {c.exactness === 'exact'
              ? 'Identity match'
              : c.exactness === 'unconfirmed'
                ? 'Identity incomplete, unconfirmed'
                : 'Variant uncertain'}
          </p>
          {c.imageUrl && !broken.includes(c.imageUrl) ? (
            <img
              src={c.imageUrl}
              alt="Catalogue reference"
              referrerPolicy="no-referrer"
              onError={() => setBroken((a) => [...a, c.imageUrl!])}
            />
          ) : (
            <p className="small muted">
              Catalogue image not available. The source link is available above.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
