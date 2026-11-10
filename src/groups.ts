import { type Card } from './model';

export type GroupKind = 'set' | 'player';
export type CardGroup = {
  key: string;
  name: string;
  detail: string;
  cards: Card[];
  setCount: number;
};
const normalize = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export function groupKey(card: Card, kind: GroupKind) {
  const f = card.fields;
  if (kind === 'player')
    return normalize(f.name || f.romanization || f.japaneseName) || 'unassigned-player';
  if (!f.set.trim()) return 'unassigned-set';
  return JSON.stringify([f.category, f.product, f.maker, f.year, f.set].map(normalize));
}
export function groupCards(cards: Card[], kind: GroupKind, sort = 'name'): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const card of cards) {
    const key = groupKey(card, kind);
    const f = card.fields;
    if (!groups.has(key))
      groups.set(key, {
        key,
        name:
          kind === 'set'
            ? f.set.trim() || 'No set'
            : (f.name || f.romanization || f.japaneseName).trim() || 'No player or character',
        detail:
          kind === 'set' && f.set.trim()
            ? [f.year, f.maker, f.product].filter(Boolean).join(' · ')
            : '',
        cards: [],
        setCount: 0,
      });
    groups.get(key)!.cards.push(card);
  }
  for (const group of groups.values()) {
    group.setCount = new Set(
      group.cards.filter((c) => c.fields.set.trim()).map((c) => groupKey(c, 'set')),
    ).size;
    if (kind === 'player')
      group.detail = [
        ...new Set(
          group.cards
            .map((c) => c.fields.japaneseName)
            .filter((name) => name && name !== group.name),
        ),
      ].join(' · ');
  }
  const latest = (group: CardGroup, field: 'updatedAt' | 'year') =>
    group.cards.reduce((value, card) => {
      const candidate = field === 'year' ? card.fields.year : card.updatedAt;
      return candidate > value ? candidate : value;
    }, '');
  return [...groups.values()].sort(
    (a, b) =>
      (sort === 'recent'
        ? latest(b, 'updatedAt').localeCompare(latest(a, 'updatedAt'))
        : sort === 'year'
          ? latest(b, 'year').localeCompare(latest(a, 'year'))
          : 0) || a.name.localeCompare(b.name),
  );
}
