import { useEffect, useRef, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { Cloud } from '@phosphor-icons/react/Cloud';
import { MoonStars } from '@phosphor-icons/react/MoonStars';
import { SignOut } from '@phosphor-icons/react/SignOut';
import { Sun } from '@phosphor-icons/react/Sun';
import { UserCircle } from '@phosphor-icons/react/UserCircle';
import { useWorkspace } from '../hooks/useWorkspace';
import { api, type User } from '../lib/api';
import { type Theme } from '../lib/theme';
import { AdminConsole } from './AdminConsole';

// Returning to the site mounts a fresh practice view, which fetches the current catalog.
const catalogChanged = () => {};

export function AdminWorkspace({ user, onLogout, onPreview }: { user: User; onLogout: () => void; onPreview: () => void }) {
  const workspace = useWorkspace(user.id);
  const [pendingTheme, setPendingTheme] = useState<Theme>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const logoutPending = useRef(false);
  const theme = pendingTheme ?? workspace.settings.theme;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (pendingTheme === workspace.settings.theme) setPendingTheme(undefined); }, [pendingTheme, workspace.settings.theme]);

  function toggleTheme() {
    if (!workspace.settingsReady) return;
    const next = theme === 'light' ? 'dark' : 'light';
    setPendingTheme(next); setError('');
    void workspace.updateSettings({ theme: next }).catch(() => {
      if (mounted.current) { setPendingTheme(undefined); setError('外观设置保存失败'); }
    });
  }
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true; setBusy(true); setError('');
    try {
      await api('/api/auth/logout', { method: 'POST', body: {}, headers: { 'X-Workspace-Owner': user.id } });
      if (mounted.current) onLogout();
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : '退出失败');
    } finally {
      logoutPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="administration-app">
    <header className="administration-header">
      <div className="administration-brand"><Cloud size={32} aria-hidden="true" /><span>云打字</span><span className="administration-badge">管理端</span></div>
      <div className="administration-actions">
        <button className="outline-button" disabled={busy} onClick={onPreview}><ArrowSquareOut size={18} aria-hidden="true" />预览网站</button>
        <button className="administration-theme" disabled={!workspace.settingsReady} aria-label={theme === 'dark' ? '切换至日间模式' : '切换至夜间模式'} aria-pressed={theme === 'dark'} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={20} aria-hidden="true" /> : <MoonStars size={20} aria-hidden="true" />}<span>{theme === 'dark' ? '日间' : '夜间'}</span>
        </button>
        <button className="outline-button administration-account" title="退出登录" disabled={busy} onClick={() => void logout()}><UserCircle size={20} aria-hidden="true" /><span>{user.username}</span><SignOut size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <main className="administration-content" aria-label="管理工作区">
      {error && <p className="form-error" role="alert">{error}</p>}
      <AdminConsole ownerId={user.id} onCatalogChange={catalogChanged} />
    </main>
  </div>;
}
