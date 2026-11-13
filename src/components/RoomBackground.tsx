import { useMemo, useState, type ReactNode } from 'react';
import { isBackgroundConfig, type BackgroundConfig, type BackgroundTheme } from '../lib/background';

export function RoomBackground({ theme, background, children }: { theme: BackgroundTheme; background?: BackgroundConfig; children: ReactNode }) {
  const [failed, setFailed] = useState<string>();
  const valid = useMemo(() => isBackgroundConfig(background), [background]);
  const custom = background && background.image !== failed && valid ? background : undefined;
  return <main className={`room${custom ? ' room-custom' : ''}`}>
    {custom && <div className="custom-background" data-theme={theme} aria-hidden="true">
      <img data-testid="custom-background-image" src={custom.image} alt="" onError={() => setFailed(custom.image)}
        style={{ objectFit: custom.fit, objectPosition: `${custom.positionX}% ${custom.positionY}%`, filter: `blur(${custom.blur}px)` }} />
      <div className="background-shade" style={{ opacity: custom.shade / 100 }} />
    </div>}
    {children}
    {!custom && <img className="sleeping-cat" src="/assets/sleeping-cat.png" alt="" aria-hidden="true" />}
  </main>;
}
