// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundDialog } from '../src/components/BackgroundDialog';
import { RoomBackground } from '../src/components/RoomBackground';
import { defaultBackground, prepareBackgroundImage } from '../src/lib/background';

vi.mock('../src/lib/background', async (original) => ({ ...await original<object>(), prepareBackgroundImage: vi.fn() }));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=';
const image = { image: png, name: 'first.png', width: 1, height: 1 };
const saved = defaultBackground('light', image);
const upload = (name: string) => fireEvent.change(screen.getByLabelText('背景图片'), { target: { files: [new File(['pixels'], name, { type: 'image/png' })] } });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('background editor', () => {
  it('keeps changes as a preview until saved, and cancel leaves the persisted image untouched', async () => {
    vi.mocked(prepareBackgroundImage).mockResolvedValue({ ...image, name: 'replacement.png' });
    const onSave = vi.fn(); const onClose = vi.fn();
    render(<BackgroundDialog theme="light" value={saved} onSave={onSave} onClose={onClose} />);
    upload('replacement.png');
    await screen.findByText('replacement.png');
    fireEvent.change(screen.getByRole('slider', { name: '模糊' }), { target: { value: 6 } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('retains the draft on storage failure and can retry the same save', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValueOnce(new Error('存储空间不足')).mockResolvedValue(undefined);
    render(<BackgroundDialog theme="dark" value={saved} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByRole('slider', { name: '遮罩' }), { target: { value: 60 } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('存储空间不足');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenLastCalledWith({ ...saved, shade: 60 });
  });

  it('ignores an older upload finishing after the latest selected file', async () => {
    let first!: (value: typeof image) => void;
    vi.mocked(prepareBackgroundImage).mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockResolvedValueOnce({ ...image, name: 'latest.png' });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BackgroundDialog theme="light" onSave={onSave} onClose={() => {}} />);
    upload('slow.png'); upload('latest.png');
    await screen.findByText('latest.png');
    await act(async () => first({ ...image, name: 'slow.png' }));
    expect(screen.queryByText('slow.png')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(defaultBackground('light', { ...image, name: 'latest.png' })));
  });

  it('restores the default while an upload is pending without reviving the uploaded image', async () => {
    let resolve!: (value: typeof image) => void;
    vi.mocked(prepareBackgroundImage).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BackgroundDialog theme="light" value={saved} onSave={onSave} onClose={() => {}} />);
    upload('slow.png');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await act(async () => resolve({ ...image, name: 'slow.png' }));
    expect(screen.getByRole('img', { name: '背景预览' }).getAttribute('src')).toBe('/assets/cloud-room.png');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(undefined));
  });

  it('preserves the previous draft when replacement fails and aborts processing on close', async () => {
    vi.mocked(prepareBackgroundImage).mockRejectedValueOnce(new Error('图片无法读取'));
    const view = render(<BackgroundDialog theme="light" value={saved} onSave={vi.fn()} onClose={() => {}} />);
    upload('broken.png');
    await screen.findByRole('alert');
    expect(screen.getByText('first.png')).toBeTruthy();
    const signal = vi.mocked(prepareBackgroundImage).mock.calls[0][1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('falls back to original room art if the saved image cannot load', () => {
    const view = render(<RoomBackground theme="light" background={saved}><p>练习内容</p></RoomBackground>);
    expect(screen.getByRole('main').className).toContain('room-custom');
    fireEvent.error(screen.getByTestId('custom-background-image'));
    expect(screen.getByRole('main').className).not.toContain('room-custom');
    expect(document.querySelector('.sleeping-cat')).toBeTruthy();
    view.rerender(<RoomBackground theme="dark"><p>练习内容</p></RoomBackground>);
    expect(screen.getByRole('main').textContent).toContain('练习内容');
  });
});
