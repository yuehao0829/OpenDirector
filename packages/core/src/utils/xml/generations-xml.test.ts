/**
 * Round-trip characterization test for generations-xml (de)serialization.
 *
 * Serializes a GenerationRecord whose providerParams populate EVERY field
 * declared on GenerationParams, parses the XML back, and asserts each field
 * survives with its original type and value.
 *
 * EXPECTED TO FAIL on current code for the 6 image fields
 * (imageSize / imageQuality / imageOutputFormat / imageBackground /
 * imageModeration / imageOutputCompression): they are declared in
 * GenerationParams and listed in PROVIDER_PARAM_KNOWN_KEYS, but
 * createGenerationElement / parseGenerationElement have no explicit
 * serialize/parse branches for them, and the unknown-key fallback loops skip
 * known keys — so the fields are silently dropped on both ends.
 *
 * duration=5.5 additionally exposes a parseInt-vs-Number bug on the parse
 * side (parseInt("5.5", 10) === 5, while speed uses Number() and survives),
 * which this test also surfaces. Do not fix here — this test characterizes
 * the bugs; the fix lands in a separate task.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  serializeGenerationsFile,
  parseGenerationsFile,
  type GenerationRecord,
  type GenerationProviderParams,
} from './generations-xml';

// ─── Minimal DOMParser mock ──────────────────────────────────────────────
// The vitest environment is `node`, which has no global DOMParser (the XML
// parser relies on it). We reuse the same lightweight hand-rolled parser used
// by services/project-io.test.ts so the public parseGenerationsFile entry
// point can be exercised in unit tests without a DOM.

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
    return this.childNodes.map((child) => child.textContent ?? '').join('');
  }
}

class TestDocument {
  constructor(public readonly documentElement: TestElement | null) {}
  querySelector(_selector: string): null {
    return null;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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
      if (!token.trim()) continue;

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
        if (!root) root = element;
        if (stack.length > 0) {
          stack[stack.length - 1]?.childNodes.push(element);
        }
        if (!selfClosing) stack.push(element);
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

function installDomParserMock(): void {
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
}

// ─── Fixture: a record with every provider param field populated ────────

const record: GenerationRecord = {
  id: 'gen-roundtrip-1',
  status: 'completed',
  fragmentId: 'frag-1',
  fragmentName: 'Fragment 1',
  prompt: 'a cinematic shot of a city at night',
  references: [],
  providerInstanceId: 'provider-instance-1',
  providerDisplayName: 'Test Provider',
  outputType: 'video',
  isSelected: false,
  createdAt: '2026-07-06T12:00:00.000Z',
  providerParams: {
    // strings
    model: 'seedance-pro',
    modelName: 'Seedance Pro',
    aspectRatio: '21:9',
    resolution: '1080p',
    style: 'cinematic',
    negativePrompt: 'blurry, low quality',
    // image fields (currently dropped — latent bug)
    imageSize: '1024x1024',
    imageQuality: 'high',
    imageOutputFormat: 'png',
    imageBackground: 'transparent',
    imageModeration: 'low',
    // numbers
    duration: 5.5, // fractional — catches parseInt-vs-Number
    speed: 1.25,
    imageOutputCompression: 80,
    // booleans (false is meaningful — must survive, not become undefined)
    generateAudio: false,
    generateWatermark: false,
    // TTS (MiniMax)
    voiceId: 'voice-001',
    emotion: 'happy',
    audioFormat: 'mp3',
    sampleRate: '24000',
  },
};

// ─── Round-trip cases: [fieldName, expectedValue, accessor] ──────────────

const cases: Array<[string, unknown, (pp: GenerationProviderParams) => unknown]> = [
  // strings — explicit serialize + parse branches, expected to pass
  ['model', 'seedance-pro', (pp) => pp.model],
  ['modelName', 'Seedance Pro', (pp) => pp.modelName],
  ['aspectRatio', '21:9', (pp) => pp.aspectRatio],
  ['resolution', '1080p', (pp) => pp.resolution],
  ['style', 'cinematic', (pp) => pp.style],
  ['negativePrompt', 'blurry, low quality', (pp) => pp.negativePrompt],
  // numbers — speed uses Number() (passes); duration uses parseInt (fails on 5.5)
  ['duration', 5.5, (pp) => pp.duration],
  ['speed', 1.25, (pp) => pp.speed],
  // booleans — false must survive as false, not collapse to undefined
  ['generateAudio', false, (pp) => pp.generateAudio],
  ['generateWatermark', false, (pp) => pp.generateWatermark],
  // image fields — dropped by current serialize/parse, expected to fail
  ['imageSize', '1024x1024', (pp) => pp.imageSize],
  ['imageQuality', 'high', (pp) => pp.imageQuality],
  ['imageOutputFormat', 'png', (pp) => pp.imageOutputFormat],
  ['imageBackground', 'transparent', (pp) => pp.imageBackground],
  ['imageModeration', 'low', (pp) => pp.imageModeration],
  ['imageOutputCompression', 80, (pp) => pp.imageOutputCompression],
  // TTS (MiniMax) — explicit branches, expected to pass
  ['voiceId', 'voice-001', (pp) => pp.voiceId],
  ['emotion', 'happy', (pp) => pp.emotion],
  ['audioFormat', 'mp3', (pp) => pp.audioFormat],
  ['sampleRate', '24000', (pp) => pp.sampleRate],
];

describe('generations-xml providerParams round-trip', () => {
  let parsed: GenerationRecord;

  beforeAll(() => {
    installDomParserMock();
    const xml = serializeGenerationsFile({ generations: [record] });
    parsed = parseGenerationsFile(xml).generations[0];
  });

  it('serializes and parses one generation record (harness sanity)', () => {
    expect(parsed).toBeDefined();
    expect(parsed.id).toBe(record.id);
    expect(parsed.providerParams).toBeDefined();
  });

  it.each(cases)(
    '%s round-trips with correct type and value',
    (_field, expected, get) => {
      const actual = get(parsed.providerParams);
      // Type check first: distinguishes "field missing entirely" (undefined)
      // from "field present but wrong value" (e.g. 5.5 -> 5).
      expect(typeof actual).toBe(typeof expected);
      expect(actual).toBe(expected);
    },
  );
});
