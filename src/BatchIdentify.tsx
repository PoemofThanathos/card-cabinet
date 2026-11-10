import { useEffect, useRef, useState } from 'react';
import { type Card, type Suggestions, title, plainCard } from './model';
import { db, saveCard, friendlyError, setting } from './db';
import { identify } from './ai';
import { Modal } from './components';
import { SuggestionReview } from './Editor';

export function BatchIdentify({
  cards,
  onClose,
  onMessage,
}: {
  cards: Card[];
  onClose: () => void;
  onMessage: (s: string) => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [index, setIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [waiting, setWaiting] = useState(false),
    [error, setError] = useState(''),
    [current, setCurrent] = useState<Card | null>(null),
    [result, setResult] = useState<Suggestions | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function confirmBatch() {
    try {
      const day = new Date().toISOString().slice(0, 10),
        usage = await setting('aiUsage', { day, count: 0 }),
        limit = await setting('aiLimit', 3);
      if ((usage.day === day ? usage.count : 0) + cards.length > limit)
        throw new Error(
          "This batch exceeds this device's remaining daily attempt limit. Select fewer cards.",
        );
      for (const card of cards)
        for (const hash of Object.values(card.photos))
          if (!hash || !(await db.photos.get(hash)))
            throw new Error('Every selected card needs both photos on this device.');
      setConfirmed(true);
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  async function scan() {
    setBusy(true);
    setError('');
    try {
      const local = await db.cards.get(cards[index].id);
      if (!local) throw new Error('This card is no longer available.');
      setCurrent(plainCard(local));
      setWaiting(true);
      timer.current = setTimeout(() => setWaiting(false), 15000);
      setResult(await identify(plainCard(local)));
    } catch (e) {
      setError(
        friendlyError(e) +
          ' This batch is stopped. Close it to review your usage before another attempt.',
      );
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }
  async function apply(values: Partial<Card['fields']>) {
    if (!current) return;
    setBusy(true);
    try {
      await saveCard({ ...current, fields: { ...current.fields, ...values } }, [], db, current);
      setResult(null);
      setIndex((n) => n + 1);
      onMessage('Reviewed identification saved on this device.');
    } catch (e) {
      setResult(null);
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Identify selected cards"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <p>
        This batch contains {cards.length} physical {cards.length === 1 ? 'card' : 'cards'}. Each
        card sends two photo copies to your Worker and OpenAI. OpenAI API use may be billed
        separately from ChatGPT. Location metadata is removed from the copies.
      </p>
      <p className="notice">
        Review one card at a time. Nothing is applied automatically. App and Worker counters do not
        guarantee an OpenAI billing cap.
      </p>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      <ol>
        {cards.map((c, i) => (
          <li key={c.id}>
            {title(c)}
            {i < index ? ' · reviewed' : ''}
          </li>
        ))}
      </ol>
      {index >= cards.length ? (
        <p>All selected cards were reviewed.</p>
      ) : !confirmed ? (
        <button className="primary" onClick={() => void confirmBatch()}>
          Confirm batch of {cards.length} {cards.length === 1 ? 'card' : 'cards'}
        </button>
      ) : (
        <div className="button-row">
          <button className="primary" disabled={busy || waiting} onClick={() => void scan()}>
            {busy
              ? 'Identifying…'
              : waiting
                ? 'Waiting between attempts…'
                : 'Identify card ' + (index + 1) + ' of ' + cards.length}
          </button>
          <button disabled={busy} onClick={() => setIndex((n) => n + 1)}>
            Skip this card
          </button>
        </div>
      )}
      <div className="modal-footer">
        <button disabled={busy} onClick={onClose}>
          Close batch
        </button>
      </div>
      {result && current && (
        <SuggestionReview
          result={result}
          card={current}
          onClose={() => {
            setResult(null);
            setIndex((n) => n + 1);
          }}
          onApply={(values) => void apply(values)}
        />
      )}
    </Modal>
  );
}
