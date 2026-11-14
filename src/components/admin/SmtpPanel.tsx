import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { adminWrite, LoadState, SelectField, useAdminResource, type AdminProps } from './common';

const path = '/smtp';
const sources = { admin: '后台配置', deployment: '部署配置', development: '开发模式', unconfigured: '未配置' };
const securityOptions = [['starttls', 'STARTTLS'], ['tls', 'TLS']] as const;
const passwordLabels = { empty: '密码', saved: '密码（已保存）', deployment: '密码（部署配置）', unavailable: '密码（需要重填）' };
type Configuration = { host: string; port: number; security: 'starttls' | 'tls' | 'opportunistic'; from: string; username: string };
type Snapshot = {
  config: Configuration | null;
  revision: number;
  source: keyof typeof sources;
  fallback: Exclude<Snapshot['source'], 'admin'>;
  editable: boolean;
  passwordState: keyof typeof passwordLabels;
};

function formValues(config: Configuration | null) {
  return {
    host: config?.host ?? '', port: String(config?.port ?? 587), security: config?.security ?? 'starttls',
    from: config?.from ?? '', username: config?.username ?? '', password: '',
  };
}

function SmtpForm({ ownerId, initial, reload }: AdminProps & { initial: Snapshot; reload: () => void }) {
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(() => formValues(initial.config));
  const [busy, setBusy] = useState<'save' | 'verify' | 'reset' | null>(null);
  const [feedback, setFeedback] = useState<{ error?: string; status?: string }>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [conflict, setConflict] = useState(false);
  const baseline = formValues(saved.config);
  const dirty = (Object.keys(values) as (keyof typeof values)[]).some((key) => values[key] !== baseline[key]);
  const existingConnection = saved.source === 'admin' || saved.source === 'deployment';
  const keepPassword = saved.passwordState === 'saved' && values.host.trim().toLowerCase() === baseline.host
    && Number(values.port) === Number(baseline.port) && values.security === baseline.security && values.username.trim() === baseline.username;
  const draftPorts = [...new Set([587, 465, 2525, 25, Number(baseline.port)])];
  const validDraft = Boolean(values.host.trim() && values.from.trim() && [25, 465, 587, 2525].includes(Number(values.port))
    && values.security !== 'opportunistic' && (values.username.trim() ? values.password || keepPassword : !values.password));
  const disabled = Boolean(busy || conflict);
  const resetLabel = saved.fallback === 'unconfigured' ? '清除配置' : '恢复默认';
  const draft = { ...values, port: Number(values.port), from: values.from.trim(), password: values.password || undefined };

  function edit(field: keyof typeof values, value: string) {
    setFeedback({});
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function perform(action: NonNullable<typeof busy>) {
    if (disabled) return;
    setBusy(action);
    setFeedback({});
    try {
      const revision = saved.revision;
      if (action === 'verify') {
        await adminWrite(ownerId, `${path}/verify`, { revision, ...(dirty || !existingConnection ? { draft } : {}) }, 30_000);
        setFeedback({ status: 'SMTP 连接验证成功' });
      } else {
        const snapshot = await adminWrite<Snapshot>(ownerId, action === 'save' ? path : `${path}/reset`,
          action === 'save' ? { ...draft, revision } : { revision });
        setSaved(snapshot);
        setValues(formValues(snapshot.config));
        setConfirmReset(false);
        setFeedback({ status: action === 'save' ? '已保存' : saved.fallback === 'unconfigured' ? '已清除' : '已恢复默认' });
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : '操作失败';
      setConflict(problem instanceof ApiError && problem.status === 409 && message === '邮件配置已变更，请刷新后重试');
      setFeedback({ error: message });
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    if (action === 'verify') void perform('verify');
    else if (saved.editable && dirty && validDraft && !confirmReset) void perform('save');
  }

  return <form className="feature-form" onSubmit={submit}>
    <fieldset className="admin-editor-fields" disabled={disabled || !saved.editable || confirmReset}>
      <legend>SMTP · {sources[saved.source]}</legend>
      <div className="feature-form-pair">
        <label>SMTP 主机<input autoComplete="off" spellCheck={false} required maxLength={253} value={values.host} onChange={(event) => edit('host', event.target.value)} /></label>
        <SelectField label="端口" options={draftPorts.map((port) => [String(port), String(port)])}
          value={values.port} onChange={(value) => edit('port', value)} />
      </div>
      <div className="feature-form-pair">
        <SelectField label="加密方式" options={values.security === 'opportunistic'
          ? [...securityOptions, ['opportunistic', '可选 STARTTLS']] : securityOptions}
          value={values.security}
          onChange={(value) => {
            setFeedback({});
            if (value === 'tls' || value === 'starttls') setValues((previous) => ({ ...previous, security: value,
              port: value === 'tls' && previous.port === '587' ? '465' : value === 'starttls' && previous.port === '465' ? '587' : previous.port,
            }));
          }} />
        <label>发件人邮箱<input type="email" autoComplete="off" required maxLength={254} value={values.from} onChange={(event) => edit('from', event.target.value)} /></label>
      </div>
      <div className="feature-form-pair">
        <label>SMTP 账号<input autoComplete="off" spellCheck={false} maxLength={254} value={values.username} onChange={(event) => edit('username', event.target.value)} /></label>
        <label>{passwordLabels[saved.passwordState]}<input type="password" autoComplete="new-password" maxLength={1024}
          value={values.password} onChange={(event) => edit('password', event.target.value)} /></label>
      </div>
    </fieldset>
    {!saved.editable && <p className="feature-muted">部署需配置至少 32 字符的 CODE_SECRET</p>}
    {feedback.error && <p className="form-error" role="alert">{feedback.error}</p>}
    {feedback.status && <p className="feature-muted" role="status">{feedback.status}</p>}
    {confirmReset ? <>
      <p className="feature-muted">{saved.fallback === 'unconfigured' ? '清除后将停发邮件验证码。' : `清除后台密码并恢复${sources[saved.fallback]}。`}</p>
      <div className="feature-actions">
        <button type="button" className="outline-button" disabled={disabled} onClick={() => setConfirmReset(false)}>取消</button>
        <button type="button" className="primary-button" disabled={disabled} onClick={() => void perform('reset')}>{busy === 'reset' ? '处理中…' : `确认${resetLabel}`}</button>
        {conflict && <button type="button" className="outline-button" onClick={reload}>重新加载</button>}
      </div>
    </> : <div className="feature-actions">
      {conflict && <button type="button" className="outline-button" onClick={reload}>重新加载</button>}
      {saved.source === 'admin' && <button type="button" className="outline-button" disabled={disabled} onClick={() => {
        setFeedback({});
        setConfirmReset(true);
      }}>{resetLabel}</button>}
      <button type="submit" value="verify" className="outline-button" formNoValidate={!dirty && existingConnection}
        disabled={disabled || ((dirty || !existingConnection) && !validDraft)}>{busy === 'verify' ? '连接中…' : '测试连接'}</button>
      <button type="submit" value="save" className="primary-button" disabled={disabled || !saved.editable || !dirty || !validDraft}>
        {busy === 'save' ? '保存中…' : '保存'}
      </button>
    </div>}
  </form>;
}

export function SmtpPanel({ ownerId }: AdminProps) {
  const { data, error, retry } = useAdminResource<Snapshot>(ownerId, path);
  return data ? <SmtpForm ownerId={ownerId} initial={data} reload={retry} /> : <LoadState error={error} retry={retry} />;
}
