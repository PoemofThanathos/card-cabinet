import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { friendlyError, setting, setSetting } from './db';
import {
  normalizeProcessingSpeed,
  processingSpeedKey,
  processingSpeeds,
  speedProfiles,
  type ProcessingSpeed,
} from './processing-speed';

export function useProcessingSpeed(onError: (message: string) => void) {
  const stored = useLiveQuery(() => setting<unknown>(processingSpeedKey, 'normal'), []);
  const [selected, setSelected] = useState<ProcessingSpeed>();
  const speed = selected ?? normalizeProcessingSpeed(stored);
  const change = (next: ProcessingSpeed) => {
    setSelected(next);
    void setSetting(processingSpeedKey, next).catch((error) => onError(friendlyError(error)));
  };
  return [speed, change, stored !== undefined] as const;
}

export function SpeedControl({
  value,
  onChange,
  disabled = false,
  ai = false,
}: {
  value: ProcessingSpeed;
  onChange: (value: ProcessingSpeed) => void;
  disabled?: boolean;
  ai?: boolean;
}) {
  const id = useId();
  return (
    <div className="speed-control">
      <label htmlFor={id}>Processing speed</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(normalizeProcessingSpeed(event.target.value))}
      >
        {processingSpeeds.map((speed) => (
          <option key={speed} value={speed}>
            {speedProfiles[speed].label}
          </option>
        ))}
      </select>
      <p className="small muted">
        {ai
          ? 'Normal: 1 request with a 15-second pause. Fast: up to 2 at once. Ultra fast: up to 4. Model and photo quality stay the same. API limits still apply.'
          : 'Faster modes save more cards at once. Photo quality stays the same.'}
      </p>
    </div>
  );
}
