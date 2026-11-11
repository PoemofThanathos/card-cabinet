import { useEffect, useState } from 'react';
import { Save, ScanLine, ChevronDown, Check } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  type Card,
  type Field,
  type Suggestions,
  fieldLabels,
  fields,
  categories,
  products,
} from './model';
import { db, saveCard, setSetting, friendlyError } from './db';
import { identify, readIdentificationOptions } from './ai';
import { identificationLabel, type IdentificationOptions } from './ai-options';
import { Modal, PhotoPicker, PhotoView } from './components';

export function SuggestionReview({
  result,
  card,
  onApply,
  onClose,
  closeLabel = 'Discard suggestions',
  identificationOptions,
}: {
  result: Suggestions;
  card: Card;
  onApply: (values: Partial<Card['fields']>) => void;
  onClose: () => void;
  closeLabel?: string;
  identificationOptions?: IdentificationOptions;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  function apply() {
    const suggestions = result.suggestions.filter(
      (s) => checked.includes(s.field) && !s.uncertain && s.value,
    );
    const replacing = suggestions.filter(
      (s) => card.fields[s.field] && card.fields[s.field] !== s.value,
    );
    if (
      replacing.length &&
      !confirm(
        'Replace your existing values for ' +
          replacing.map((s) => fieldLabels[s.field]).join(', ') +
          '?',
      )
    )
      return;
    onApply(Object.fromEntries(suggestions.map((s) => [s.field, s.value])));
  }
  return (
    <Modal title="Review identification" onClose={onClose} wide>
      {identificationOptions && (
        <p className="small muted">{identificationLabel(identificationOptions)}</p>
      )}
      {(card.photos.front || card.photos.back) && (
        <div className="bulk-photo-pair">
          <PhotoView hash={card.photos.front} alt="Front of card being reviewed" />
          <PhotoView hash={card.photos.back} alt="Back of card being reviewed" />
        </div>
      )}
      <p className="muted">
        Suggestions can be wrong. Select only the fields you want to apply. Inferences are separate
        from text read on the card.
      </p>
      {result.warnings.map((w, i) => (
        <p className="notice" key={i}>
          {w}
        </p>
      ))}
      <div className="suggestions">
        {result.suggestions.map((s) => (
          <label className="suggestion" key={s.field}>
            <input
              type="checkbox"
              disabled={s.uncertain || !s.value}
              checked={checked.includes(s.field)}
              onChange={(e) =>
                setChecked(
                  e.target.checked ? [...checked, s.field] : checked.filter((f) => f !== s.field),
                )
              }
            />
            <div>
              <span className="field-source">
                {fieldLabels[s.field]} ·{' '}
                {s.source === 'visible_text' ? 'Read from image' : 'Model inference'}
              </span>
              <strong>{s.uncertain ? 'Uncertain, left blank' : s.value || 'No suggestion'}</strong>
              {card.fields[s.field] && (
                <span className="muted">Your current value: {card.fields[s.field]}</span>
              )}
              <small>{s.evidence}</small>
            </div>
          </label>
        ))}
      </div>
      <p className="small muted">
        This does not authenticate signatures, grade condition, or estimate value. Model uncertainty
        is not a calibrated probability.
      </p>
      <div className="modal-footer">
        <button onClick={onClose}>{closeLabel}</button>
        <button className="primary" disabled={!checked.length} onClick={apply}>
          <Check size={17} />
          Apply selected fields
        </button>
      </div>
    </Modal>
  );
}
export function Editor({
  initial,
  base,
  onClose,
  onSaved,
  onError: outerError,
}: {
  initial: Card;
  base: Card | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const savedStatus = useLiveQuery(
    async () => (await db.cards.get(initial.id))?.status,
    [initial.id],
  );
  useEffect(() => {
    if (savedStatus !== 'purged') return;
    outerError('This card was permanently deleted on another tab or device.');
    onClose();
  }, [savedStatus, outerError, onClose]);
  const [card, setCard] = useState(initial),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Suggestions | null>(null),
    [resultOptions, setResultOptions] = useState<IdentificationOptions | undefined>(),
    [dirty, setDirty] = useState(false),
    [draftReady, setDraftReady] = useState(false),
    [localError, setLocalError] = useState('');
  const onError = (message: string) => {
    setLocalError(message);
    outerError(message);
  };
  useEffect(() => {
    let current = true;
    setDraftReady(false);
    void setSetting('draft', { card, base })
      .then(() => {
        if (current) setDraftReady(true);
      })
      .catch((e) => {
        if (current) onError(friendlyError(e));
      });
    return () => {
      current = false;
    };
  }, [card, base]);
  function update(field: Field, value: string) {
    setDraftReady(false);
    setDirty(true);
    setCard((c) => ({ ...c, fields: { ...c.fields, [field]: value } }));
  }
  async function closeDraft() {
    if (busy) return;
    setBusy(true);
    try {
      await setSetting('draft', { card, base });
      onClose();
    } catch (e) {
      onError(friendlyError(e));
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await saveCard(card, [], db, base || undefined);
      await db.settings.delete('draft');
      setDirty(false);
      onSaved();
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function scan() {
    setBusy(true);
    try {
      const chosen = await readIdentificationOptions();
      if (
        !confirm(
          'Send copies of these two photos to your Cloudflare Worker and OpenAI using ' +
            identificationLabel(chosen) +
            ' for one identification? Location metadata is removed. This uses your OpenAI API balance.',
        )
      )
        return;
      setResultOptions(chosen);
      setResult(await identify(card, chosen));
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const mainFields: Field[] = [
    'category',
    'product',
    'name',
    'japaneseName',
    'romanization',
    'team',
    'maker',
    'set',
    'year',
    'cardNumber',
    'language',
    'rarity',
    'serial',
  ];
  const input = (f: Field) => (
    <label className={f === 'notes' ? 'span-2' : ''} key={f}>
      {fieldLabels[f]}
      {f === 'notes' ? (
        <textarea
          rows={4}
          maxLength={4000}
          value={card.fields[f]}
          onChange={(e) => update(f, e.target.value)}
        />
      ) : (
        <input
          list={
            f === 'category'
              ? 'categories'
              : f === 'product'
                ? 'products'
                : f === 'maker'
                  ? 'makers'
                  : undefined
          }
          maxLength={300}
          type={f === 'purchaseDate' ? 'date' : 'text'}
          value={card.fields[f]}
          onChange={(e) => update(f, e.target.value)}
          placeholder={
            f === 'japaneseName' ? '例：大谷翔平' : f === 'tags' ? 'rookie, favorites' : undefined
          }
        />
      )}
    </label>
  );
  return (
    <Modal
      title={initial.fields.name ? 'Edit card' : 'Add a card'}
      onClose={() => void closeDraft()}
      wide
    >
      {localError && (
        <p className="notice warning" role="alert">
          {localError}
        </p>
      )}
      <div className="editor-intro">
        <p>All fields are optional.</p>
        <span className="status-pill">
          {draftReady ? 'Draft saved on this device' : 'Saving draft…'}
        </span>
      </div>
      <fieldset disabled={busy}>
        <div className="photo-pair">
          {(['front', 'back'] as const).map((side) => (
            <PhotoPicker
              key={side}
              side={side}
              hash={card.photos[side]}
              onChange={(hash) => {
                setDraftReady(false);
                setDirty(true);
                setCard((c) => ({ ...c, photos: { ...c.photos, [side]: hash } }));
              }}
              onError={onError}
            />
          ))}
        </div>
        <div className="identify-bar">
          <div>
            <p>Only Identify sends photos. Manual entry stays on your device.</p>
          </div>
          <button
            className="secondary"
            disabled={!card.photos.front || !card.photos.back}
            onClick={() => void scan()}
          >
            <ScanLine size={18} />
            {busy ? 'Working…' : 'Identify'}
          </button>
        </div>
        <div className="form-grid">{mainFields.map(input)}</div>
        <details className="form-details">
          <summary>
            Visible features, notes and storage <ChevronDown size={16} />
          </summary>
          <div className="form-grid">
            {(['autograph', 'memorabilia', 'tags', 'location', 'notes'] as Field[]).map(input)}
          </div>
        </details>
        <details className="form-details">
          <summary>
            Purchase details <ChevronDown size={16} />
          </summary>
          <p className="small muted">
            Enter these yourself. Identification does not fill purchase information.
          </p>
          <div className="form-grid">
            {(
              ['purchaseDate', 'purchasePrice', 'purchaseCurrency', 'purchaseSource'] as Field[]
            ).map(input)}
          </div>
        </details>
      </fieldset>
      <datalist id="categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="products">
        {products.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="makers">
        {['BBM', 'EPOCH', 'Topps', 'Bushiroad', 'COVER'].map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="modal-footer">
        <button disabled={busy} onClick={() => void closeDraft()}>
          Keep draft & close
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <Save size={18} />
          {busy ? 'Working…' : 'Save card'}
        </button>
      </div>
      {dirty && (
        <p className="small muted">Your changes become part of the collection when you save.</p>
      )}
      {result && (
        <SuggestionReview
          card={card}
          result={result}
          identificationOptions={resultOptions}
          onClose={() => setResult(null)}
          onApply={(values) => {
            setCard((c) => ({ ...c, fields: { ...c.fields, ...values } }));
            setDirty(true);
            setResult(null);
          }}
        />
      )}
    </Modal>
  );
}
