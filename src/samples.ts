import { db, makePhoto, saveCard, type CabinetDB, type Photo } from './db';
import { newCard, type Card } from './model';

const people = {
  shohei: ['Shohei Ohtani', '大谷翔平'],
  roki: ['Roki Sasaki', '佐々木朗希'],
  yoshinobu: ['Yoshinobu Yamamoto', '山本由伸'],
  ichiro: ['Ichiro Suzuki', '鈴木一朗'],
  suisei: ['Hoshimachi Suisei', '星街すいせい'],
  pekora: ['Usada Pekora', '兎田ぺこら'],
};
const sets = [
  {
    set: 'NPB sample series',
    maker: 'BBM',
    year: '2024',
    category: 'Japanese baseball',
    product: 'Baseball card',
    people: ['shohei', 'roki'],
    color: '#294f42',
  },
  {
    set: 'NPB sample series',
    maker: 'EPOCH',
    year: '2025',
    category: 'Japanese baseball',
    product: 'Baseball card',
    people: ['roki', 'yoshinobu'],
    color: '#795238',
  },
  {
    set: 'NPB sample collection',
    maker: 'Topps',
    year: '2025',
    category: 'Japanese baseball',
    product: 'Baseball card',
    people: ['yoshinobu', 'ichiro'],
    color: '#415978',
  },
  {
    set: 'MLB sample collection',
    maker: 'Topps',
    year: '2025',
    category: 'MLB',
    product: 'Baseball card',
    people: ['shohei', 'ichiro'],
    color: '#923f43',
  },
  {
    set: 'Hololive sample collection',
    maker: 'COVER',
    year: '2025',
    category: 'Hololive',
    product: 'Hololive Official Card Game',
    people: ['suisei', 'pekora'],
    color: '#486d88',
  },
  {
    set: 'Hololive sample collection',
    maker: 'Bushiroad',
    year: '2025',
    category: 'Hololive',
    product: 'Weiss Schwarz',
    people: ['suisei', 'pekora'],
    color: '#74618b',
  },
] as const;
export const sampleCardIds = sets.flatMap((_, setIndex) =>
  [0, 1].map(
    (index) => `cab1cab1-0000-4000-8000-${String(setIndex * 2 + index + 1).padStart(12, '0')}`,
  ),
);

export function sampleCards(): Card[] {
  return sets.flatMap((set, setIndex) =>
    set.people.map((person, index) => {
      const card = newCard();
      card.id = sampleCardIds[setIndex * 2 + index];
      Object.assign(card.fields, {
        category: set.category,
        product: set.product,
        maker: set.maker,
        set: set.set,
        year: set.year,
        name: people[person][0],
        japaneseName: people[person][1],
        cardNumber: `TEST-${String(index + 1).padStart(3, '0')}`,
        language: 'Japanese / English',
        tags: 'test-card',
        notes:
          'Fictional test card with generated artwork. Set, year and card number are sample data, not a real card identification.',
      });
      return card;
    }),
  );
}

export async function samplePhoto(card: Card, side: 'front' | 'back'): Promise<Photo> {
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 780;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not create the test card artwork.');
  const set = sets[Math.floor((Number(card.id.slice(-12)) - 1) / 2)];
  ctx.fillStyle = '#f8f4e9';
  ctx.fillRect(0, 0, 560, 780);
  ctx.fillStyle = set.color;
  ctx.fillRect(22, 22, 516, 736);
  ctx.fillStyle = '#f8f4e9';
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText('TEST CARD', 48, 64);
  ctx.textAlign = 'right';
  ctx.fillText(card.fields.year, 510, 64);
  ctx.textAlign = 'left';
  if (side === 'front') {
    ctx.strokeStyle = '#f8f4e966';
    ctx.lineWidth = 2;
    for (let size = 170; size > 40; size -= 40) {
      ctx.beginPath();
      ctx.moveTo(280, 300 - size);
      ctx.lineTo(280 + size, 300);
      ctx.lineTo(280, 300 + size);
      ctx.lineTo(280 - size, 300);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = '#f8f4e9';
    ctx.font = 'bold 70px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText(
      card.fields.name
        .split(' ')
        .map((word) => word[0])
        .join(''),
      280,
      325,
    );
    ctx.font = '20px sans-serif';
    ctx.fillText('SAMPLE', 280, 415);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#f8f4e9';
    ctx.font = '26px Georgia';
    ctx.fillText('Sample data', 48, 160);
    ctx.font = '18px sans-serif';
    [
      'Generated artwork for testing.',
      'Not a real trading card.',
      'No photo or AI request was used.',
      '',
      card.fields.product,
      card.fields.cardNumber,
    ].forEach((line, index) => ctx.fillText(line, 48, 215 + index * 40, 460));
  }
  ctx.fillStyle = '#f8f4e9';
  ctx.fillRect(22, 535, 516, 223);
  ctx.fillStyle = set.color;
  ctx.font = 'bold 31px Georgia';
  ctx.fillText(card.fields.name, 46, 589, 468);
  ctx.font = '23px sans-serif';
  ctx.fillText(card.fields.japaneseName, 46, 631, 468);
  ctx.font = '17px sans-serif';
  ctx.fillText(card.fields.set, 46, 681, 468);
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(`${card.fields.maker} · ${card.fields.cardNumber} · ${side}`, 46, 720, 468);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Test artwork could not be saved.'))),
      'image/jpeg',
      0.9,
    ),
  );
  return makePhoto(blob);
}

export async function addSampleCards(database: CabinetDB = db, photoFactory = samplePhoto) {
  const cards = sampleCards();
  const present = new Set(
    (await database.cards.bulkGet(cards.map((card) => card.id)))
      .filter(Boolean)
      .map((card) => card!.id),
  );
  const prepared: { card: Card; photos: Photo[] }[] = [];
  for (const card of cards.filter((card) => !present.has(card.id))) {
    const front = await photoFactory(card, 'front');
    const back = await photoFactory(card, 'back');
    card.photos = { front: front.hash, back: back.hash };
    prepared.push({ card, photos: [front, back] });
  }
  let added = 0;
  await database.transaction('rw', database.cards, database.photos, database.queue, async () => {
    for (const item of prepared) {
      if (await database.cards.get(item.card.id)) continue;
      await saveCard(item.card, item.photos, database);
      added++;
    }
  });
  return added;
}
