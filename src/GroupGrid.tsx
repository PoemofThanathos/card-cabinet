import { ArrowUpRight, BookOpen, Users } from 'lucide-react';
import { PhotoView } from './components';
import { type CardGroup, type GroupKind } from './groups';

export function GroupGrid({
  groups,
  kind,
  hashes,
  onOpen,
}: {
  groups: CardGroup[];
  kind: GroupKind;
  hashes: Set<string>;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="group-grid" aria-label={kind === 'set' ? 'Sets' : 'Players'}>
      {groups.map((group) => {
        const covers = [
          ...new Set(
            group.cards
              .map((card) => card.photos.front)
              .filter((hash): hash is string => !!hash && hashes.has(hash)),
          ),
        ].slice(0, 3);
        return (
          <button
            className="group-tile"
            key={group.key}
            aria-label={`Open ${kind} ${group.name}${kind === 'set' && group.detail ? ', ' + group.detail : ''}`}
            onClick={() => onOpen(group.key)}
          >
            <div className={'group-art ' + kind} aria-hidden="true">
              {covers.length ? (
                covers.map((hash, index) => (
                  <div className={'group-cover cover-' + index} key={hash}>
                    <PhotoView hash={hash} alt="" />
                  </div>
                ))
              ) : (
                <div className="group-placeholder">
                  {kind === 'set' ? <BookOpen size={42} /> : <Users size={42} />}
                </div>
              )}
              <span className="group-count">
                {group.cards.length} {group.cards.length === 1 ? 'card' : 'cards'}
              </span>
            </div>
            <div className="group-copy">
              <h2>{group.name}</h2>
              {group.detail && <p>{group.detail}</p>}
              <div className="group-footer">
                <span>
                  {kind === 'player'
                    ? `${group.setCount} ${group.setCount === 1 ? 'set' : 'sets'}`
                    : 'View cards'}
                </span>
                <ArrowUpRight size={16} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
