import { useState, type FormEvent } from 'react';
import type { SiteSettings, SiteSettingsSnapshot } from '../../../server/site-settings';
import { ApiError } from '../../lib/api';
import { adminWrite, LoadState, SelectField, useAdminResource, type AdminProps } from './common';

const settingsPath = '/settings/site';
const availabilityFields = [
  ['registrationEnabled', '开放注册'],
  ['guestPracticeEnabled', '游客新开在线练习'],
  ['guestLeaderboardEnabled', '游客提交排行榜'],
] as const;
const availabilityOptions = [['on', '开启'], ['off', '关闭']] as const;
const thresholdFields = [
  ['reviewThresholdZh', '中文（字/分钟）'],
  ['reviewThresholdEn', '英文（WPM）'],
] as const;

function SiteSettingsForm({ ownerId, initial, reload }: AdminProps & { initial: SiteSettingsSnapshot; reload: () => void }) {
  const [saved, setSaved] = useState(initial);
  const [availability, setAvailability] = useState(initial.settings);
  const [thresholds, setThresholds] = useState({
    reviewThresholdZh: String(initial.settings.reviewThresholdZh),
    reviewThresholdEn: String(initial.settings.reviewThresholdEn),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const dirty = availabilityFields.some(([field]) => availability[field] !== saved.settings[field]) ||
    thresholdFields.some(([field]) => Number(thresholds[field]) !== saved.settings[field]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dirty || conflict) return;
    const settings: SiteSettings = {
      ...availability, reviewThresholdZh: Number(thresholds.reviewThresholdZh), reviewThresholdEn: Number(thresholds.reviewThresholdEn),
    };
    setBusy(true);
    setError('');
    try {
      const updated = await adminWrite<SiteSettingsSnapshot>(ownerId, settingsPath, { settings, revision: saved.revision });
      setSaved(updated);
      setSavedMessage('已保存');
    } catch (problem) {
      setConflict(problem instanceof ApiError && problem.status === 409);
      setError(problem instanceof Error ? problem.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return <form className="feature-form" onSubmit={save}>
    <fieldset className="settings-group" disabled={busy || conflict}>
      <legend>访问权限</legend>
      <div className="feature-form-pair">
        {availabilityFields.map(([field, label]) => <SelectField key={field} label={label} options={availabilityOptions}
          value={availability[field] ? 'on' : 'off'} onChange={(value) => {
            setSavedMessage('');
            setAvailability((previous) => ({ ...previous, [field]: value === 'on' }));
          }} />)}
      </div>
    </fieldset>
    <fieldset className="settings-group" disabled={busy || conflict}>
      <legend>速度复核阈值</legend>
      <div className="feature-form-pair">
        {thresholdFields.map(([field, label]) => <label key={field}>{label}<input type="number" min={1} max={1000}
          step={1} required value={thresholds[field]} onChange={(event) => {
            const { value } = event.target;
            setSavedMessage('');
            setThresholds((previous) => ({ ...previous, [field]: value }));
          }} /></label>)}
      </div>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    {savedMessage && <p className="feature-muted" role="status">{savedMessage}</p>}
    <div className="feature-actions">
      {conflict && <button type="button" className="outline-button" onClick={reload}>重新加载</button>}
      <button className="primary-button" disabled={busy || !dirty || conflict}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </form>;
}

export function SiteSettingsPanel({ ownerId }: AdminProps) {
  const { data, error, retry } = useAdminResource<SiteSettingsSnapshot>(ownerId, settingsPath);
  return data ? <SiteSettingsForm ownerId={ownerId} initial={data} reload={retry} /> : <LoadState error={error} retry={retry} />;
}
