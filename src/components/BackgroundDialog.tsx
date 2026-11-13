import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ImageSquare } from '@phosphor-icons/react/ImageSquare';
import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { defaultBackground, prepareBackgroundImage, type BackgroundConfig, type BackgroundTheme } from '../lib/background';
import { Dialog } from './Dialog';

type Props = {
  theme: BackgroundTheme;
  value?: BackgroundConfig;
  onSave: (value: BackgroundConfig | undefined) => Promise<void>;
  onClose: () => void;
};

export function BackgroundDialog({ theme, value, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);
  const savingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; operation.current?.abort(); };
  }, []);
  useEffect(() => { if (!dirty) setDraft(value); }, [value, dirty]);

  function cancelProcessing() {
    generation.current++;
    operation.current?.abort();
    setProcessing(false);
  }
  function close() {
    if (savingRef.current) return;
    cancelProcessing();
    onClose();
  }
  async function choose(file?: File) {
    if (!file || savingRef.current) return;
    cancelProcessing();
    const current = generation.current;
    const controller = new AbortController();
    operation.current = controller;
    setError(''); setProcessing(true);
    try {
      const image = await prepareBackgroundImage(file, controller.signal);
      if (!mounted.current || current !== generation.current) return;
      setDraft((previous) => ({ ...previous ?? defaultBackground(theme, image), ...image }));
      setDirty(true);
    } catch (problem) {
      if (mounted.current && current === generation.current && !controller.signal.aborted) setError(problem instanceof Error ? problem.message : '图片处理失败');
    } finally {
      if (mounted.current && current === generation.current) setProcessing(false);
    }
  }
  function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false);
    if (savingRef.current) return;
    if (event.dataTransfer.files.length !== 1) { setError('一次选择一张图片'); return; }
    void choose(event.dataTransfer.files[0]);
  }
  function change(patch: Partial<BackgroundConfig>) {
    setDraft((previous) => previous && { ...previous, ...patch });
    setDirty(true);
  }
  async function save() {
    if (!dirty || processing || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await onSave(draft);
      if (mounted.current) onClose();
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : '背景保存失败');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const sliders = [
    ['positionX', '水平位置', 100, '%'], ['positionY', '垂直位置', 100, '%'], ['blur', '模糊', 12, 'px'], ['shade', '遮罩', 80, '%'],
  ] as const;

  return <Dialog title={theme === 'dark' ? '夜间背景' : '日间背景'} onClose={close} dismissible={!saving} className="background-dialog">
    <form className="background-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className={`background-preview${dragging ? ' is-dragging' : ''}`} data-theme={theme}
        onDragOver={(event) => { event.preventDefault(); if (!saving) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        <img alt="背景预览" src={draft?.image ?? `/assets/cloud-room${theme === 'dark' ? '-night' : ''}.png`}
          style={{ objectFit: draft?.fit ?? 'cover', objectPosition: `${draft?.positionX ?? 50}% ${draft?.positionY ?? 50}%`, filter: `blur(${draft?.blur ?? 0}px)` }} />
        <div className="background-shade" style={{ opacity: (draft?.shade ?? 0) / 100 }} />
        <div className="background-preview-sample" aria-hidden="true"><span>云打字练习</span><i /><i /></div>
      </div>
      <div className="background-file-row" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <input ref={input} hidden aria-label="背景图片" type="file" accept="image/jpeg,image/png,image/webp" disabled={saving}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file); }} />
        <button type="button" className="outline-button" disabled={saving} onClick={() => input.current?.click()}><ImageSquare size={18} aria-hidden="true" />{draft ? '更换图片' : '选择图片'}</button>
        <span className="feature-muted">JPG / PNG / WebP · 10 MB</span>
      </div>
      {processing && <p className="feature-muted" role="status">正在处理图片…</p>}
      {draft && <>
        <div className="background-file-info"><span>{draft.name}</span><span>{draft.width} × {draft.height}</span></div>
        <fieldset className="background-controls" disabled={saving || processing}>
          <legend className="sr-only">背景显示</legend>
          <label className="background-fit">显示方式<select value={draft.fit} onChange={(event) => change({ fit: event.target.value as BackgroundConfig['fit'] })}><option value="cover">填满</option><option value="contain">完整显示</option></select></label>
          <div className="background-ranges">{sliders.map(([key, label, max, unit]) => <label className="settings-range" key={key}>
            <span>{label}</span><input type="range" aria-label={label} min={0} max={max} step={1} value={draft[key]} onChange={(event) => change({ [key]: event.target.valueAsNumber })} /><span aria-hidden="true">{draft[key]}{unit}</span>
          </label>)}</div>
        </fieldset>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="background-editor-actions">
        <button type="button" className="text-button" disabled={saving || (!draft && !processing)} onClick={() => { cancelProcessing(); setDraft(undefined); setDirty(true); setError(''); }}><ArrowCounterClockwise size={17} aria-hidden="true" />恢复默认</button>
        <div><button type="button" className="outline-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" disabled={!dirty || processing || saving}>{saving ? '保存中…' : '保存'}</button></div>
      </div>
    </form>
  </Dialog>;
}
