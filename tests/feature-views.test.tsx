// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { ArticleLibrary } from '../src/components/ArticleLibrary';
import { DraftsView } from '../src/components/DraftsView';
import { MistakesView } from '../src/components/MistakesView';
import { RecordsView } from '../src/components/RecordsView';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { StatsView } from '../src/components/StatsView';
import { defaultSettings, type ArticleSnapshot, type PracticeRecord, type PrivateArticle, type SavedPractice } from '../src/lib/models';

afterEach(cleanup);

const spring: ArticleSnapshot = {
  id: 'spring', title: '春日', author: '林之', theme: '思念与成长', language: 'zh', difficulty: 'beginner', custom: false, text: '春风细雨。',
};
const other: ArticleSnapshot = { ...spring, id: 'autumn', title: '秋日', author: '张月' };
const record: PracticeRecord = {
  recordId: 'one', language: 'zh', difficulty: 'beginner', duration: 300, speed: 42, accuracy: 95,
  finishedAt: Date.now(), article: spring, typed: '春风', offset: 1, total: 1, articleTotal: 5,
  mistakes: [{ position: 1, expected: '风', actual: '封' }],
};

function LibraryHarness({ initial = [spring, other] }: { initial?: ArticleSnapshot[] }) {
  const [articles, setArticles] = useState(initial);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selected, setSelected] = useState<ArticleSnapshot>();
  return <>
    <ArticleLibrary articles={articles} favorites={favorites}
      onToggleFavorite={(id) => setFavorites((all) => all.includes(id) ? all.filter((value) => value !== id) : [...all, id])}
      onSelect={setSelected}
      onSave={(saved) => setArticles((all) => [...all.filter((item) => item.id !== saved.id), saved])}
      onDelete={(id) => setArticles((all) => all.filter((item) => item.id !== id))}
    />
    {selected && <output>{selected.text}</output>}
  </>;
}

describe('article library', () => {
  it('applies author search to favorites and recovers when search is cleared', () => {
    render(<LibraryHarness />);
    fireEvent.click(screen.getByRole('button', { name: '收藏《春日》' }));
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索' }), { target: { value: '张月' } });
    expect(screen.queryByText('春日')).toBeNull();
    expect(screen.queryByText('秋日')).toBeNull();
    expect(screen.getByText('暂无匹配文章')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索' }), { target: { value: '林之' } });
    expect(screen.getByText('春日')).toBeTruthy();
    expect(screen.queryByText('秋日')).toBeNull();
  });

  it('creates a private article on origins without crypto.randomUUID', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      render(<LibraryHarness />);
      fireEvent.click(screen.getByRole('button', { name: '新建文章' }));
      const dialog = screen.getByRole('dialog', { name: '新建文章' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: '标题' }), { target: { value: '短笺' } });
      fireEvent.change(within(dialog).getByRole('textbox', { name: '正文' }), { target: { value: '山海' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('heading', { name: '短笺' })).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
      else Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    }
  });

  it('imports normalized TXT and validates blank edits without replacing the saved article', async () => {
    const original: PrivateArticle = { ...spring, id: 'my-spring', custom: true };
    render(<LibraryHarness initial={[original]} />);
    fireEvent.click(screen.getByRole('button', { name: '我的文章' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑《春日》' }));
    const dialog = screen.getByRole('dialog', { name: '编辑文章' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '正文' }), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('正文');
    const bytes = new TextEncoder().encode('\uFEFF春风\r\n细雨。');
    const file = new File([bytes], '春日.txt', { type: 'text/plain' });
    fireEvent.change(within(dialog).getByLabelText('导入 TXT'), { target: { files: [file] } });
    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement).value).toBe('春风\n细雨。'));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByText('春日')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '练习《春日》' }));
    expect(screen.getByRole('status').textContent).toBe('春风\n细雨。');
  });
});

describe('personal progress views', () => {
  it('continues the saved draft snapshot and confirms deletion', () => {
    const draft: SavedPractice = {
      id: 'draft', article: spring, typed: '春风', elapsedMs: 1000, backspaces: 0, duration: 300, mode: 'timed',
      strict: false, offset: 0, recordId: 'round', offline: true, ownerId: null, savedAt: Date.now(),
    };
    function DraftHarness() {
      const [drafts, setDrafts] = useState([draft]);
      const [continued, setContinued] = useState('');
      return <><DraftsView drafts={drafts} onResume={(value) => setContinued(value.typed)} onDelete={(id) => setDrafts((all) => all.filter((value) => value.id !== id))} /><output>{continued}</output></>;
    }
    render(<DraftHarness />);
    fireEvent.click(screen.getByRole('button', { name: '继续《春日》' }));
    expect(screen.getByRole('status').textContent).toBe('春风');
    fireEvent.click(screen.getByRole('button', { name: '删除《春日》' }));
    expect(screen.getByText('春日')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    expect(screen.queryByText('春日')).toBeNull();
  });

  it('starts drills from selected recorded mistakes', () => {
    function MistakeHarness() {
      const [selected, setSelected] = useState<ArticleSnapshot>();
      return <><MistakesView records={[record]} onPractice={setSelected} /><output>{selected?.text}</output></>;
    }
    render(<MistakeHarness />);
    const practice = screen.getByRole('button', { name: '专项练习' }) as HTMLButtonElement;
    expect(practice.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '风' }));
    fireEvent.click(practice);
    expect(screen.getByRole('status').textContent).toBe('风');
  });

  it('opens stored history details, continues partial progress, and keeps legacy actions unavailable', () => {
    const legacy: PracticeRecord = { ...record, recordId: 'legacy', article: undefined, typed: undefined, mistakes: undefined };
    function RecordHarness() {
      const [selection, setSelection] = useState('');
      return <>
        <RecordsView records={[record, legacy]} onReplay={(article) => setSelection(article.text)} onContinue={(entry) => setSelection(entry.typed ?? '')} />
        <output>{selection}</output>
      </>;
    }
    render(<RecordHarness />);
    fireEvent.click(screen.getByRole('button', { name: '《春日》详情' }));
    const details = screen.getByRole('dialog', { name: '练习详情' });
    expect(within(details).getByText('2 / 5')).toBeTruthy();
    expect(within(details).getByText('封')).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: '继续练习' }));
    expect(screen.getByRole('status').textContent).toBe('春风');
    fireEvent.click(screen.getByRole('button', { name: '中文 · 入门详情' }));
    const legacyDetails = screen.getByRole('dialog', { name: '练习详情' });
    expect(within(legacyDetails).queryByRole('button', { name: '重练' })).toBeNull();
    expect(within(legacyDetails).queryByRole('button', { name: '继续练习' })).toBeNull();
  });

  it('switches statistics by language with accessible values for the actual daily trend', () => {
    render(<StatsView records={[record, { ...record, language: 'en', speed: 24 }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('table', { name: '每日统计' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '24 WPM' })).toBeTruthy();
    expect(screen.queryByRole('cell', { name: '42 字/分' })).toBeNull();
  });

  it('locks timing rules while leaving reader settings adjustable', () => {
    function SettingsHarness() {
      const [settings, setSettings] = useState(defaultSettings);
      return <SettingsDialog settings={settings} onChange={(patch) => setSettings((old) => ({ ...old, ...patch }))} locked onClose={() => {}} onFocus={() => {}} focused={false} syncState="guest" onSync={() => {}} isSignedIn={false} />;
    }
    render(<SettingsHarness />);
    expect((screen.getByRole('spinbutton', { name: '限时（分钟）' }) as HTMLInputElement).disabled).toBe(true);
    const fontSize = screen.getByRole('slider', { name: '字号' }) as HTMLInputElement;
    fireEvent.change(fontSize, { target: { value: '23' } });
    expect(fontSize.value).toBe('23');
  });
});
