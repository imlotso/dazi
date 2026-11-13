import { useState, type ChangeEvent } from 'react';
import type { ReaderSettings, SyncState } from '../lib/models';
import { Dialog } from './Dialog';

type Props = {
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  locked: boolean;
  onClose: () => void;
  onFocus: () => void;
  focused: boolean;
  syncState: SyncState;
  onSync: () => void;
  isSignedIn: boolean;
  onBackground?: () => void;
  hasBackground?: boolean;
};

const syncNames: Record<SyncState, string> = {
  guest: '仅本机', loading: '正在读取', syncing: '同步中', synced: '已同步', error: '同步失败',
};

export function SettingsDialog({ settings, onChange, locked, onClose, onFocus, focused, syncState, onSync, isSignedIn, onBackground, hasBackground }: Props) {
  const [invalidMinutes, setInvalidMinutes] = useState<string>();
  const canSetMinutes = !locked && settings.mode === 'timed';

  function changeMinutes(event: ChangeEvent<HTMLInputElement>) {
    const { value, valueAsNumber } = event.currentTarget;
    if (Number.isInteger(valueAsNumber) && valueAsNumber >= 1 && valueAsNumber <= 60) {
      setInvalidMinutes(undefined);
      onChange({ minutes: valueAsNumber });
    } else {
      setInvalidMinutes(value);
    }
  }

  return <Dialog title="练习设置" onClose={onClose}>
    <div className="feature-form settings">
      <fieldset className="settings-group">
        <legend>规则</legend>
        <div className="feature-form-pair">
          <label>练习模式<select value={settings.mode} disabled={locked} onChange={(event) => onChange({ mode: event.target.value as ReaderSettings['mode'] })}><option value="timed">限时</option><option value="article">整篇</option></select></label>
          <label>限时（分钟）<input type="number" min={1} max={60} step={1} value={canSetMinutes ? invalidMinutes ?? settings.minutes : settings.minutes} disabled={!canSetMinutes} aria-invalid={canSetMinutes && invalidMinutes !== undefined} onChange={changeMinutes} /></label>
        </div>
        {canSetMinutes && invalidMinutes !== undefined && <p className="form-error" role="alert">请输入 1–60 的整数</p>}
        <label className="settings-check"><input type="checkbox" checked={settings.strict} disabled={locked} onChange={(event) => onChange({ strict: event.target.checked })} />严格纠错</label>
        <label className="settings-check"><input type="checkbox" checked={settings.autoPause} onChange={(event) => onChange({ autoPause: event.target.checked })} />离开页面自动暂停</label>
      </fieldset>
      <fieldset className="settings-group">
        <legend>阅读</legend>
        <label className="settings-range"><span>字号</span><input aria-label="字号" type="range" min={16} max={24} step={1} value={settings.fontSize} onChange={(event) => onChange({ fontSize: event.target.valueAsNumber })} /><span aria-hidden="true">{settings.fontSize} px</span></label>
        <label className="settings-range"><span>行距</span><input aria-label="行距" type="range" min={1.4} max={2.2} step={.1} value={settings.lineHeight} onChange={(event) => onChange({ lineHeight: event.target.valueAsNumber })} /><span aria-hidden="true">{settings.lineHeight.toFixed(1)}</span></label>
        <label className="settings-range"><span>可见行数</span><input aria-label="可见行数" type="range" min={3} max={8} step={1} value={settings.visibleLines} onChange={(event) => onChange({ visibleLines: event.target.valueAsNumber })} /><span aria-hidden="true">{settings.visibleLines} 行</span></label>
        <div className="feature-actions">
          <button className="outline-button feature-action-button" onClick={onFocus}>{focused ? '退出专注' : '进入专注'}</button>
        </div>
      </fieldset>
      <fieldset className="settings-group">
        <legend>外观</legend>
        <div className="settings-sync"><span className="feature-muted">{hasBackground ? '自定义背景' : '默认背景'}</span><button className="outline-button feature-action-button" onClick={onBackground}>背景图</button></div>
      </fieldset>
      <fieldset className="settings-group">
        <legend>同步</legend>
        <div className="settings-sync">
          <span role="status">{syncNames[syncState]}</span>
          {isSignedIn && <button className="outline-button feature-action-button" disabled={syncState === 'loading' || syncState === 'syncing'} onClick={onSync}>立即同步</button>}
        </div>
      </fieldset>
    </div>
  </Dialog>;
}
