import { describe, expect, it } from 'vitest';
import { resolveLocalFilePath } from './generation-xml-repository';

/**
 * resolveLocalFilePath decides which on-disk file a reference uploads (TOS) or
 * base64-reads. The key invariant: prefer the in-project copy (relativePath)
 * over the ORIGINAL import path (sourcePath), because the user may delete the
 * original after import while the project-folder copy is stable. These tests
 * pin that priority (the bug surfaced 2026-07-17: imported refs uploaded their
 * original — possibly-deleted — path instead of the project copy).
 */
describe('resolveLocalFilePath', () => {
  const folderPath = '/proj';

  it('prefers the in-project relativePath over sourcePath (imported asset)', () => {
    // A copied import has BOTH: relativePath = project-internal copy, sourcePath =
    // original (possibly-deleted) path. Must return the project copy.
    const assets = [
      {
        id: 'a1',
        relativePath: 'Assets/Audio/a1.wav',
        sourcePath: 'D:\\Downloads\\clip.wav',
      },
    ];
    expect(resolveLocalFilePath('a1', assets, folderPath)).toBe(
      '/proj/Assets/Audio/a1.wav',
    );
  });

  it('returns the generated asset path (relativePath, no sourcePath)', () => {
    // Generated assets have only relativePath (no original import path).
    const assets = [
      { id: 'gen-1', relativePath: 'Generated/Audio/gen-1.mp3' },
    ];
    expect(resolveLocalFilePath('gen-1', assets, folderPath)).toBe(
      '/proj/Generated/Audio/gen-1.mp3',
    );
  });

  it('returns sourcePath verbatim in reference mode (relativePath === sourcePath)', () => {
    // copyToProject=false sets relativePath = sourcePath (an absolute path).
    // Must NOT prefix folderPath (would yield an invalid drive-letter path).
    const assets = [
      {
        id: 'ref-1',
        relativePath: 'D:\\Downloads\\clip.wav',
        sourcePath: 'D:\\Downloads\\clip.wav',
      },
    ];
    expect(resolveLocalFilePath('ref-1', assets, folderPath)).toBe(
      'D:\\Downloads\\clip.wav',
    );
  });

  it('falls back to sourcePath when relativePath is absent', () => {
    const assets = [{ id: 'a2', sourcePath: 'D:\\Media\\voice.wav' }];
    expect(resolveLocalFilePath('a2', assets, folderPath)).toBe(
      'D:\\Media\\voice.wav',
    );
  });

  it('returns null when the asset has neither path', () => {
    const assets = [{ id: 'a3' }];
    expect(resolveLocalFilePath('a3', assets, folderPath)).toBeNull();
  });

  it('returns a non-scheme url verbatim when no asset matches', () => {
    // A bare local path (not an asset id, no scheme) is returned as-is.
    expect(
      resolveLocalFilePath('/abs/path/file.wav', [], folderPath),
    ).toBe('/abs/path/file.wav');
  });

  it('returns null for a remote-scheme url with no matching asset', () => {
    expect(
      resolveLocalFilePath('https://example.com/x.wav', [], folderPath),
    ).toBeNull();
  });
});
