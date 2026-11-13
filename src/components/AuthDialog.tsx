import { useState, type FormEvent } from 'react';
import { api, type User } from '../lib/api';
import { Dialog } from './Dialog';

type Mode = 'password' | 'code' | 'register' | 'reset';

export function AuthDialog({ onClose, onLogin }: { onClose: () => void; onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [username, setUsername] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const switchMode = (next: Mode) => { setMode(next); setError(''); setNotice(''); setCode(''); };

  async function sendCode() {
    if (!email.trim()) { setError('请先填写邮箱'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/auth/code', { method: 'POST', body: { email, purpose: mode === 'register' ? 'register' : mode === 'reset' ? 'reset' : 'login' } });
      setNotice('如果邮箱符合条件，验证码将发送到该邮箱，10 分钟内有效。');
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'reset') {
        await api('/api/auth/reset', { method: 'POST', body: { email, code, password } });
        switchMode('password'); setIdentifier(email); setPassword(''); setNotice('密码已更新，请重新登录。');
      } else {
        const path = mode === 'register' ? '/api/auth/register' : mode === 'code' ? '/api/auth/login-code' : '/api/auth/login';
        const body = mode === 'register' ? { username, email, password, code } : mode === 'code' ? { email, code } : { identifier, password };
        const data = await api<{ user: User }>(path, { method: 'POST', body });
        onLogin(data.user); onClose();
      }
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }

  const heading = mode === 'register' ? '创建账号' : mode === 'reset' ? '找回密码' : '欢迎回来';
  return <Dialog title={heading} onClose={onClose}>
    <p className="dialog-intro">{mode === 'register' ? '绑定邮箱，在不同设备上留住练习记录。' : mode === 'reset' ? '用注册邮箱验证身份，然后设置新密码。' : '登录后，你的练习记录会陪你去更多地方。'}</p>
    {(mode === 'password' || mode === 'code') && <div className="auth-tabs" role="tablist" aria-label="登录方式">
      <button role="tab" aria-selected={mode === 'password'} onClick={() => switchMode('password')}>密码登录</button>
      <button role="tab" aria-selected={mode === 'code'} onClick={() => switchMode('code')}>邮箱验证码</button>
    </div>}
    <form onSubmit={submit} className="auth-form">
      {mode === 'register' && <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="3–24 位字母、数字或下划线" required /></label>}
      {mode === 'password' ? <label>用户名或邮箱<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" placeholder="输入用户名或邮箱" required /></label> :
        <label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" required /></label>}
      {mode !== 'password' && <label>邮箱验证码<span className="code-field"><input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" maxLength={6} required /><button type="button" className="text-button" disabled={busy} onClick={sendCode}>获取验证码</button></span></label>}
      {mode !== 'code' && <label>{mode === 'reset' ? '新密码' : '密码'}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'password' ? 'current-password' : 'new-password'} placeholder={mode === 'password' ? '输入密码' : '至少 10 位'} minLength={mode === 'password' ? undefined : 10} required /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      <button className="primary-button auth-submit" disabled={busy}>{busy ? '请稍候…' : mode === 'register' ? '注册并登录' : mode === 'reset' ? '更新密码' : '登录'}</button>
    </form>
    <div className="auth-links">
      {mode !== 'register' ? <button className="text-button" onClick={() => switchMode('register')}>创建账号</button> : <button className="text-button" onClick={() => switchMode('password')}>已有账号？去登录</button>}
      {mode !== 'reset' && <button className="text-button" onClick={() => switchMode('reset')}>忘记密码？</button>}
      {mode === 'reset' && <button className="text-button" onClick={() => switchMode('password')}>返回登录</button>}
    </div>
  </Dialog>;
}
