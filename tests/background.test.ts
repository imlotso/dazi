// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBackground, isBackgroundConfig, prepareBackgroundImage } from '../src/lib/background';
import { deleteWorkspaceValue, isWorkspaceItem, putWorkspaceValue, readWorkspace, workspaceValue } from '../src/lib/workspace';
import { pngFixture } from './background-fixture';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=';
const picture = { image: png, name: 'cloud.png', width: 1, height: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function mockRaster(width = 4000, height = 2000, broken = false) {
  const revoked = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: revoked });
  vi.stubGlobal('Image', class {
    naturalWidth = width;
    naturalHeight = height;
    onload?: () => void;
    onerror?: () => void;
    set src(_value: string) { queueMicrotask(() => broken ? this.onerror?.() : this.onload?.()); }
  });
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png);
  return { revoked, draw, encode };
}

describe('custom background assets', () => {
  it('checks actual encoded dimensions rather than trusting image metadata', () => {
    expect(isBackgroundConfig(defaultBackground('light', { ...picture, image: pngFixture(10_000, 5000) }))).toBe(false);
    expect(isBackgroundConfig(defaultBackground('light', { ...picture, image: pngFixture(20, 10) }))).toBe(false);
    expect(isBackgroundConfig(defaultBackground('light', { ...picture, image: pngFixture(20, 10), width: 20, height: 10 }))).toBe(true);
    expect(isBackgroundConfig(defaultBackground('light', { ...picture, image: pngFixture(20, 10, true), width: 20, height: 10 }))).toBe(false);
  });
  it('rejects active/external content, mismatched raster signatures and out-of-range display controls', () => {
    const value = defaultBackground('light', picture);
    expect(isBackgroundConfig(value)).toBe(true);
    for (const invalid of [
      { ...value, image: 'https://example.com/picture.jpg' },
      { ...value, image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
      { ...value, image: png.replace('image/png', 'image/webp') },
      { ...value, image: png + '\n' },
      { ...value, positionX: 101 }, { ...value, positionY: -1 },
      { ...value, blur: 13 }, { ...value, shade: 81 }, { ...value, width: 2561 },
      { ...value, fit: 'stretch' }, { ...value, name: 'x'.repeat(121) },
    ]) expect(isBackgroundConfig(invalid)).toBe(false);
    expect(isWorkspaceItem({ kind: 'background', id: 'light', updatedAt: 1, value })).toBe(true);
    expect(isWorkspaceItem({ kind: 'background', id: 'another-slot', updatedAt: 1, value })).toBe(false);
  });

  it('re-encodes a large upload at a bounded size and releases its temporary URL', async () => {
    const { revoked, draw } = mockRaster();
    const result = await prepareBackgroundImage(new File(['pixels'], '云间.png', { type: 'image/png' }));
    expect(result).toMatchObject({ name: '云间.png', width: 2560, height: 1280, image: png });
    expect(draw).toHaveBeenCalled();
    expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:test');
  });

  it('rejects unsupported or oversized files before decoding', async () => {
    const { draw } = mockRaster();
    await expect(prepareBackgroundImage(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }))).rejects.toThrow('JPG');
    const big = new File(['image'], 'large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    await expect(prepareBackgroundImage(big)).rejects.toThrow('10 MB');
    expect(draw).not.toHaveBeenCalled();
  });

  it('releases failed decodes and rejects excessive pixel counts', async () => {
    const failed = mockRaster(100, 100, true);
    await expect(prepareBackgroundImage(new File(['bad'], 'bad.png', { type: 'image/png' }))).rejects.toThrow('读取');
    expect(failed.revoked).toHaveBeenCalledExactlyOnceWith('blob:test');
    mockRaster(10_000, 10_000);
    await expect(prepareBackgroundImage(new File(['large'], 'large.png', { type: 'image/png' }))).rejects.toThrow('尺寸');
  });

  it('reduces oversized encodings and never returns an asset above the stored limit', async () => {
    const { encode } = mockRaster(2000, 1000);
    encode.mockReturnValueOnce('data:image/png;base64,' + 'A'.repeat(1_100_000));
    const result = await prepareBackgroundImage(new File(['pixels'], 'cloud.png', { type: 'image/png' }));
    expect(result.image).toBe(png);
    expect(encode.mock.calls.length).toBeGreaterThan(1);
    encode.mockReturnValue('data:image/png;base64,' + 'A'.repeat(1_100_000));
    await expect(prepareBackgroundImage(new File(['pixels'], 'cloud.png', { type: 'image/png' }))).rejects.toThrow('压缩');
  });

  it('keeps theme/owner images separate, persists reset and permits an explicit replacement', async () => {
    const day = defaultBackground('light', picture);
    const night = defaultBackground('dark', picture);
    await putWorkspaceValue('background-a', 'background', 'light', day);
    await putWorkspaceValue('background-a', 'background', 'dark', night);
    expect(await readWorkspace('background-b')).toEqual([]);
    await deleteWorkspaceValue('background-a', 'background', 'light');
    const saved = await readWorkspace('background-a');
    expect(workspaceValue(saved, 'background', 'light')).toBeUndefined();
    expect(workspaceValue(saved, 'background', 'dark')).toEqual(night);
    await putWorkspaceValue('background-a', 'background', 'light', day);
    expect(workspaceValue(await readWorkspace('background-a'), 'background', 'light')).toEqual(day);
  });
});
