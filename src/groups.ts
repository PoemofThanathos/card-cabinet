import { type Card } from './model';

export type GroupKind = 'set' | 'player';
export type CardGroup = {
  key: string;
  name: string;
  detail: string;
  cards: Card[];
  setCount: number;
};
export type SetSection = 'Base' | 'Parallels' | 'Inserts' | 'Relics & autos' | 'Unclassified';
const clean = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const normalize = (value: string) => clean(value).toLocaleLowerCase();
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const makerNames: Record<string, string> = { topps: 'Topps', bbm: 'BBM', epoch: 'EPOCH' };
const genericProducts = new Set([
  '',
  'baseball card',
  'baseball cards',
  'trading card',
  'trading cards',
]);
const basePattern = /^(?:base(?: set| card| cards)?|regular(?: card| cards)?)$/i;
const parallelPattern =
  /\b(?:parallel(?:s)?|refractor(?:s)?|prizm|foil(?:board)?)\b|^(?:gold|silver|bronze|red|blue|green|orange|purple|pink|black|platinum|rainbow)(?:\s+\d+\/\d+)?$/i;
const relicPattern =
  /\b(?:auto(?:s|graph(?:s)?)?|relic(?:s)?|memorabilia|patch(?:es)?|signature(?:s)?)\b/i;
const insertPattern =
  /^(?:insert(?:s)?|time to shine|(?:19|20)\d{2} Topps Baseball(?: Chrome)? All[- ]Stars|new wonder|night breaker|elite of nine|performance backed|finest moments|great record|miyabi)$/i;

function positiveFeature(value: string) {
  const text = normalize(value);
  return (
    !!text &&
    !/^(?:no\b|none\b|not\b|n\/a\b|unknown\b|unclear\b|false$)/.test(text) &&
    !/\b(?:facsimile|printed signature|printed autograph)\b/.test(text)
  );
}
function sectionFor(card: Card, suffix: string, knownInsert: boolean): SetSection {
  const f = card.fields;
  const rarity = clean(f.rarity);
  if (
    positiveFeature(f.autograph) ||
    positiveFeature(f.memorabilia) ||
    relicPattern.test(suffix) ||
    relicPattern.test(rarity)
  )
    return 'Relics & autos';
  if (parallelPattern.test(rarity) || parallelPattern.test(suffix)) return 'Parallels';
  if (knownInsert || /\binsert(?:s)?\b/i.test(rarity)) return 'Inserts';
  if (basePattern.test(rarity) || basePattern.test(suffix)) return 'Base';
  return 'Unclassified';
}

/** Display-only grouping. Card fields retain the complete printed set and variant names. */
export function setIdentity(card: Card) {
  const f = card.fields;
  if (!f.set.trim())
    return {
      familyKey: 'unassigned-set',
      name: 'No set',
      detail: '',
      section: 'Unclassified' as SetSection,
    };
  let family = clean(f.set);
  let year = clean(f.year);
  let maker = clean(f.maker);
  // Only a year at the release-name prefix is inferred. Retro insert years stay in the title.
  const leading = family.match(/^(?:(Topps|BBM|EPOCH)\s+)?((?:19|20)\d{2})\s+/i);
  if (!year && leading) year = leading[2];
  if (!maker) maker = leading?.[1] ?? family.match(/^(?:\d{4}\s+)?(Topps|BBM|EPOCH)\b/i)?.[1] ?? '';
  maker = makerNames[normalize(maker)] ?? maker;
  // Remove repeated release prefixes, never a conflicting year or another maker.
  for (let pass = 0; pass < 2; pass++) {
    if (year) family = family.replace(new RegExp('^' + escapePattern(year) + '\\s+', 'i'), '');
    if (maker) family = family.replace(new RegExp('^' + escapePattern(maker) + '\\s+', 'i'), '');
  }
  if (normalize(maker) === 'topps') family = family.replace(/^Baseball\s+(Series\b)/i, '$1');
  family = family.replace(
    /^Series\s+(One|Two)\b/i,
    (_, word: string) => 'Series ' + (word.toLowerCase() === 'one' ? '1' : '2'),
  );
  let suffix = '';
  const split = family.match(/^(.+?)\s+(?:-|–|—|·)\s+(.+)$/);
  if (
    split &&
    (insertPattern.test(split[2]) ||
      basePattern.test(split[2]) ||
      parallelPattern.test(split[2]) ||
      relicPattern.test(split[2]))
  ) {
    family = split[1];
    suffix = split[2];
  } else {
    // Support common manually entered section names without stripping arbitrary subtitles.
    const section = family.match(
      /^(.+?)\s+(Base(?: Set)?|Parallels?|Relics?(?: and autos| & autos)?|Autos)$/i,
    );
    if (section) {
      family = section[1];
      suffix = section[2];
    }
  }
  const knownInsert = insertPattern.test(suffix) || insertPattern.test(family);
  const section = sectionFor(card, suffix, knownInsert);
  const product = genericProducts.has(normalize(f.product)) ? '' : clean(f.product);
  let category = /^(?:npb|japanese baseball)$/i.test(clean(f.category))
    ? 'Japanese baseball'
    : clean(f.category);
  // A missing category can use an explicit league or an unambiguous release name.
  // An entered category, even a conflicting one, is never replaced here.
  if (
    !category &&
    (/\bNPB\b/i.test(family) ||
      (maker === 'EPOCH' && /^Hiroshima Toyo Carp Premier Edition$/i.test(family)))
  ) {
    category = 'Japanese baseball';
  }
  const name = [year, normalize(family) === normalize(maker) ? '' : maker, family]
    .filter(Boolean)
    .join(' ');
  return {
    familyKey: JSON.stringify([category, product, maker, year, family].map(normalize)),
    name,
    detail: [category, product].filter(Boolean).join(' · '),
    section,
  };
}
export function groupKey(card: Card, kind: GroupKind) {
  const f = card.fields;
  if (kind === 'player')
    return normalize(f.name || f.romanization || f.japaneseName) || 'unassigned-player';
  const identity = setIdentity(card);
  return identity.familyKey === 'unassigned-set'
    ? identity.familyKey
    : JSON.stringify([identity.familyKey, identity.section]);
}
export function groupCards(cards: Card[], kind: GroupKind, sort = 'name'): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const card of cards) {
    const key = groupKey(card, kind);
    const f = card.fields;
    const identity = kind === 'set' ? setIdentity(card) : null;
    if (!groups.has(key))
      groups.set(key, {
        key,
        name: identity
          ? identity.familyKey === 'unassigned-set'
            ? identity.name
            : `${identity.name} · ${identity.section}`
          : (f.name || f.romanization || f.japaneseName).trim() || 'No player or character',
        detail: identity?.detail ?? '',
        cards: [],
        setCount: 0,
      });
    groups.get(key)!.cards.push(card);
  }
  for (const group of groups.values()) {
    group.setCount = new Set(
      group.cards.filter((c) => c.fields.set.trim()).map((c) => setIdentity(c).familyKey),
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
