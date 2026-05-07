import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { FileInfo, MediaMetadata } from '../types/persistence';
import type { FileFilter, FileSelectOptions, FileSystemAdapter } from '../adapters/types';
import { assetToRecord } from '../utils/xml';
import { buildImportedProjectFromTimelineData } from './media-exchange-project';
import { loadProjectFiles, saveProjectFiles } from './project-io';

class MemoryFileSystemAdapter implements FileSystemAdapter {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(['/']);

  async readFile(path: string): Promise<ArrayBuffer> {
    const normalized = this.normalize(path);
    const file = this.files.get(normalized);
    if (!file) {
      throw new Error(`File not found: ${normalized}`);
    }
    return file.slice().buffer as ArrayBuffer;
  }

  async writeFile(path: string, data: ArrayBuffer | Blob): Promise<void> {
    if (data instanceof Blob) {
      throw new Error('Blob writes are not supported in this test adapter');
    }

    const normalized = this.normalize(path);
    this.ensureParentDir(normalized);
    this.files.set(normalized, new Uint8Array(data));
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(this.normalize(path));
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalize(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async copyFile(src: string, dest: string): Promise<number> {
    const source = this.files.get(this.normalize(src));
    if (!source) {
      throw new Error(`File not found: ${src}`);
    }
    const cloned = source.slice();
    await this.writeFile(dest, cloned.buffer.slice(cloned.byteOffset, cloned.byteOffset + cloned.byteLength));
    return cloned.byteLength;
  }

  async moveFile(src: string, dest: string): Promise<void> {
    const normalizedSrc = this.normalize(src);
    const file = this.files.get(normalizedSrc);
    if (!file) {
      throw new Error(`File not found: ${src}`);
    }
    await this.writeFile(dest, file.slice().buffer as ArrayBuffer);
    this.files.delete(normalizedSrc);
  }

  async getFileSize(path: string): Promise<number> {
    const file = this.files.get(this.normalize(path));
    return file?.byteLength ?? 0;
  }

  async createDir(path: string): Promise<void> {
    this.ensureDirSync(this.normalize(path));
  }

  async removeDir(path: string, recursive: boolean = false): Promise<void> {
    const normalized = this.normalize(path);
    if (recursive) {
      for (const filePath of [...this.files.keys()]) {
        if (filePath.startsWith(`${normalized}/`) || filePath === normalized) {
          this.files.delete(filePath);
        }
      }
      for (const dirPath of [...this.directories]) {
        if (dirPath.startsWith(`${normalized}/`) || dirPath === normalized) {
          this.directories.delete(dirPath);
        }
      }
      this.directories.add('/');
      return;
    }

    this.directories.delete(normalized);
  }

  async listDir(path: string): Promise<FileInfo[]> {
    const normalized = this.normalize(path);
    const entries = new Map<string, FileInfo>();

    for (const dirPath of this.directories) {
      if (!this.isDirectChild(normalized, dirPath) || dirPath === normalized) {
        continue;
      }
      const name = dirPath.slice(normalized.length + 1);
      entries.set(name, {
        name,
        path: dirPath,
        isDirectory: true,
        size: 0,
        modifiedAt: new Date(0),
      });
    }

    for (const [filePath, contents] of this.files.entries()) {
      if (!this.isDirectChild(normalized, filePath)) {
        continue;
      }
      const name = filePath.slice(normalized.length + 1);
      entries.set(name, {
        name,
        path: filePath,
        isDirectory: false,
        size: contents.byteLength,
        modifiedAt: new Date(0),
      });
    }

    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async ensureDir(path: string): Promise<void> {
    this.ensureDirSync(this.normalize(path));
  }

  async selectFile(_options?: FileSelectOptions): Promise<string | string[] | null> {
    return null;
  }

  async selectFolder(): Promise<string | null> {
    return null;
  }

  async saveFile(_defaultPath?: string, _filters?: FileFilter[]): Promise<string | null> {
    return null;
  }

  async createProjectFolder(name: string, parentPath: string): Promise<string> {
    const fullPath = `${parentPath}/${name}`;
    await this.ensureDir(fullPath);
    return fullPath;
  }

  async importAssetToProject(): Promise<string> {
    throw new Error('Not implemented in test adapter');
  }

  async generateThumbnail(_videoPath: string, outputPath?: string): Promise<string> {
    const targetPath = outputPath ?? '/generated-thumbnail.jpg';
    await this.writeFile(targetPath, new TextEncoder().encode('thumbnail').buffer);
    return this.normalize(targetPath);
  }

  async generateImageThumbnail(_imagePath: string, _maxSize?: number, outputPath?: string): Promise<string> {
    const targetPath = outputPath ?? '/generated-image-thumbnail.jpg';
    await this.writeFile(targetPath, new TextEncoder().encode('thumbnail').buffer);
    return this.normalize(targetPath);
  }

  async generateAudioPeakData(_audioPath: string, outputPath: string): Promise<string> {
    await this.writeFile(outputPath, new TextEncoder().encode('peak').buffer);
    return this.normalize(outputPath);
  }

  async getMediaMetadata(_path: string): Promise<MediaMetadata> {
    return { duration: 0 };
  }

  async saveAutosaveSnapshot(): Promise<string> {
    throw new Error('Not implemented in test adapter');
  }

  private normalize(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized === '') {
      return '/';
    }
    return normalized.endsWith('/') && normalized.length > 1
      ? normalized.slice(0, -1)
      : normalized;
  }

  private ensureParentDir(path: string): void {
    const lastSlash = path.lastIndexOf('/');
    const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
    this.ensureDirSync(parent);
  }

  private ensureDirSync(path: string): void {
    const segments = this.normalize(path).split('/').filter(Boolean);
    let current = '';
    this.directories.add('/');
    for (const segment of segments) {
      current = `${current}/${segment}`;
      this.directories.add(current);
    }
  }

  private isDirectChild(parent: string, child: string): boolean {
    if (parent === child) {
      return false;
    }

    if (parent === '/') {
      return child.startsWith('/') && child.slice(1).split('/').length === 1;
    }

    if (!child.startsWith(`${parent}/`)) {
      return false;
    }

    return child.slice(parent.length + 1).split('/').length === 1;
  }
}

const TEST_NODE = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  COMMENT_NODE: 8,
};

class TestTextNode {
  readonly nodeType = TEST_NODE.TEXT_NODE;

  constructor(public readonly textContent: string) {}
}

class TestElement {
  readonly nodeType = TEST_NODE.ELEMENT_NODE;
  readonly attributes: Array<{ name: string; value: string }>;
  readonly childNodes: Array<TestElement | TestTextNode> = [];

  constructor(
    public readonly tagName: string,
    attributes: Record<string, string>,
  ) {
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }));
  }

  get textContent(): string {
    return this.childNodes
      .map((child) => child.textContent ?? '')
      .join('');
  }
}

class TestDocument {
  constructor(public readonly documentElement: TestElement | null) {}

  querySelector(selector: string): null {
    return selector === 'parsererror' ? null : null;
  }
}

class TestDomParser {
  parseFromString(xml: string): TestDocument {
    const cleaned = xml
      .replace(/<\?xml[\s\S]*?\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const tokens = cleaned.match(/<[^>]+>|[^<]+/g) ?? [];
    const stack: TestElement[] = [];
    let root: TestElement | null = null;

    for (const token of tokens) {
      if (!token.trim()) {
        continue;
      }

      if (token.startsWith('</')) {
        stack.pop();
        continue;
      }

      if (token.startsWith('<')) {
        const selfClosing = token.endsWith('/>');
        const inner = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
        const firstWhitespace = inner.search(/\s/);
        const tagName = firstWhitespace === -1 ? inner : inner.slice(0, firstWhitespace);
        const attrSource = firstWhitespace === -1 ? '' : inner.slice(firstWhitespace + 1);
        const attributes: Record<string, string> = {};
        const attrPattern = /([^\s=]+)="([^"]*)"/g;

        for (const match of attrSource.matchAll(attrPattern)) {
          attributes[match[1]] = decodeXml(match[2]);
        }

        const element = new TestElement(tagName, attributes);
        if (!root) {
          root = element;
        }
        if (stack.length > 0) {
          stack[stack.length - 1]?.childNodes.push(element);
        }
        if (!selfClosing) {
          stack.push(element);
        }
        continue;
      }

      const text = decodeXml(token);
      if (text.trim()) {
        stack[stack.length - 1]?.childNodes.push(new TestTextNode(text));
      }
    }

    return new TestDocument(root);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('project-io exchange import persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'DOMParser', {
      value: TestDomParser,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'Node', {
      value: TEST_NODE,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI_INTERNALS__: {
          convertFileSrc: (path: string) => `asset://${path}`,
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        convertFileSrc: (path: string) => `asset://${path}`,
      },
      configurable: true,
      writable: true,
    });
  });

  it('can save and reload imported external-media projects without losing Timeline.xml semantics', async () => {
    const fs = new MemoryFileSystemAdapter();
    const project = buildImportedProjectFromTimelineData({
      projectName: 'Imported Exchange Project',
      fps: 24,
      width: 1920,
      height: 1080,
      assets: [
        {
          id: 'asset-video',
          name: 'plate.mp4',
          localPath: 'C:/external/plate.mp4',
          type: 'video',
          duration: 8000,
          width: 1920,
          height: 1080,
        },
        {
          id: 'asset-audio',
          name: 'voice.wav',
          localPath: 'C:/external/voice.wav',
          type: 'audio',
          duration: 4000,
        },
      ],
      tracks: [
        {
          id: 'video-track',
          type: 'video',
          name: 'Video Track',
          muted: false,
          order: 1,
          fragments: [
            {
              id: 'video-fragment',
              name: 'Opening',
              start: 1000,
              duration: 3000,
              trimStart: 250,
              sourceAssetId: 'asset-video',
              crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
            },
          ],
        },
        {
          id: 'audio-track',
          type: 'audio',
          name: 'Audio Track',
          muted: true,
          order: 0,
          fragments: [
            {
              id: 'audio-fragment',
              name: 'VO',
              start: 0,
              duration: 2500,
              trimStart: 125,
              sourceAssetId: 'asset-audio',
            },
          ],
        },
      ],
    }, 'Fallback Project');

    project.folderPath = 'C:/Projects/ImportedExchangeProject';
    project.fileName = 'ImportedExchangeProject.odp';

    await saveProjectFiles(
      project,
      fs,
      project.folderPath,
      project.fileName,
      undefined,
      { assets: project.assets.map(assetToRecord) },
    );

    const loaded = await loadProjectFiles(fs, project.folderPath, project.fileName);

    expect(loaded.tracks).toEqual([
      {
        id: 'video-track',
        type: 'video',
        name: 'Video Track',
        order: 1,
        muted: false,
        locked: false,
      },
      {
        id: 'audio-track',
        type: 'audio',
        name: 'Audio Track',
        order: 0,
        muted: true,
        locked: false,
      },
    ]);

    expect(loaded.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'video-fragment',
        trackId: 'video-track',
        start: 1000,
        duration: 3000,
        trimStart: 250,
        sourceAssetId: 'asset-video',
        references: [
          expect.objectContaining({
            assetId: 'asset-video',
            type: 'video',
            cropRect: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          }),
        ],
      }),
      expect.objectContaining({
        id: 'audio-fragment',
        trackId: 'audio-track',
        start: 0,
        duration: 2500,
        trimStart: 125,
        sourceAssetId: 'asset-audio',
      }),
    ]));

    expect(loaded.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        sourcePath: 'C:/external/plate.mp4',
        url: 'asset://C:/external/plate.mp4',
        relativePath: '',
      }),
      expect.objectContaining({
        id: 'asset-audio',
        sourcePath: 'C:/external/voice.wav',
        url: 'asset://C:/external/voice.wav',
        relativePath: '',
      }),
    ]));

    const videoAsset = loaded.assets?.find((asset) => asset.id === 'asset-video');
    const audioAsset = loaded.assets?.find((asset) => asset.id === 'asset-audio');
    expect(videoAsset?.thumbnailUrl).toBe(
      'asset://C:/Projects/ImportedExchangeProject/Thumbnails/asset-video.jpg',
    );
    expect(audioAsset?.waveformDataPath).toBe(
      'C:/Projects/ImportedExchangeProject/Thumbnails/asset-audio.peak',
    );
  });

  it('does not probe missing video audio metadata during project load', async () => {
    const fs = new MemoryFileSystemAdapter();
    const metadataSpy = vi.spyOn(fs, 'getMediaMetadata').mockResolvedValue({
      duration: 8000,
      width: 1920,
      height: 1080,
      audioChannels: undefined,
      sampleRate: undefined,
    });

    const project = buildImportedProjectFromTimelineData({
      projectName: 'Imported Silent Video Project',
      fps: 24,
      width: 1920,
      height: 1080,
      assets: [
        {
          id: 'asset-video',
          name: 'silent.mp4',
          localPath: 'C:/external/silent.mp4',
          type: 'video',
          duration: 8000,
          width: 1920,
          height: 1080,
        },
      ],
      tracks: [
        {
          id: 'video-track',
          type: 'video',
          name: 'Video Track',
          muted: false,
          order: 0,
          fragments: [
            {
              id: 'video-fragment',
              name: 'Silent Clip',
              start: 0,
              duration: 3000,
              sourceAssetId: 'asset-video',
            },
          ],
        },
      ],
    }, 'Fallback Project');

    project.folderPath = 'C:/Projects/SilentVideoProject';
    project.fileName = 'SilentVideoProject.odp';

    await saveProjectFiles(
      project,
      fs,
      project.folderPath,
      project.fileName,
      undefined,
      { assets: project.assets.map(assetToRecord) },
    );

    const firstLoad = await loadProjectFiles(fs, project.folderPath, project.fileName);
    const secondLoad = await loadProjectFiles(fs, project.folderPath, project.fileName);

    expect(metadataSpy).not.toHaveBeenCalled();
    expect(firstLoad.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        audioChannels: undefined,
        sampleRate: undefined,
        mediaMetadataHydrated: undefined,
      }),
    ]));
    expect(secondLoad.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        mediaMetadataHydrated: undefined,
      }),
    ]));

    const assetsXml = new TextDecoder().decode(
      await fs.readFile('C:/Projects/SilentVideoProject/Assets.xml'),
    );
    expect(assetsXml.includes('mediaMetadataHydrated="true"')).toBe(false);
  });
});
