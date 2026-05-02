/**
 * XML Parser - Converts XML strings to JavaScript objects
 */

import type { XmlElement, XmlNode, XmlParseOptions, CoercedValue } from './types';

const DEFAULT_PARSE_OPTIONS: XmlParseOptions = {
  trim: true,
  parseNumbers: true,
  parseDates: true,
  ignoreComments: true,
};

/**
 * Type guard to check if a node is an element
 */
export function isXmlElement(node: XmlNode): node is XmlElement {
  return node.type === 'element';
}

/**
 * Parse XML string to XmlElement tree
 */
export function parseXml(xml: string, options: XmlParseOptions = {}): XmlElement {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };

  // Use browser's DOMParser
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  // Check for parsing errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent}`);
  }

  const root = doc.documentElement;
  if (!root) {
    throw new Error('XML document has no root element');
  }

  return parseElement(root, opts);
}

/**
 * Parse a DOM Element to XmlElement
 */
function parseElement(element: Element, options: XmlParseOptions): XmlElement {
  const attributes: Record<string, string> = {};
  const children: XmlNode[] = [];

  // Parse attributes
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    if (attr) {
      attributes[attr.name] = attr.value;
    }
  }

  // Parse child nodes
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];

    if (child.nodeType === Node.ELEMENT_NODE) {
      children.push(parseElement(child as Element, options));
    } else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      const text = child.textContent || '';
      const trimmed = options.trim ? text.trim() : text;

      if (trimmed) {
        children.push({
          type: child.nodeType === Node.CDATA_SECTION_NODE ? 'cdata' : 'text',
          content: trimmed,
        });
      }
    } else if (child.nodeType === Node.COMMENT_NODE) {
      if (!options.ignoreComments) {
        children.push({
          type: 'text',
          content: child.textContent || '',
        });
      }
    }
  }

  return {
    type: 'element',
    tagName: element.tagName,
    attributes,
    children,
  };
}

/**
 * Get text content from an element
 */
export function getElementText(element: XmlElement): string {
  const texts: string[] = [];

  for (const child of element.children) {
    if (child.type === 'text' || child.type === 'cdata') {
      texts.push(child.content || '');
    }
  }

  return texts.join('');
}

/**
 * Get attribute value with type coercion
 */
export function getAttribute(
  element: XmlElement,
  name: string,
  options: XmlParseOptions = {}
): CoercedValue {
  const value = element.attributes[name];
  if (value === undefined) {
    return null;
  }

  return coerceValue(value, options);
}

/**
 * Get child element by tag name
 */
export function getChildElement(element: XmlElement, tagName: string): XmlElement | null {
  for (const child of element.children) {
    if (isXmlElement(child) && child.tagName === tagName) {
      return child;
    }
  }
  return null;
}

/**
 * Get all child elements by tag name
 */
export function getChildElements(element: XmlElement, tagName?: string): XmlElement[] {
  const results: XmlElement[] = [];

  for (const child of element.children) {
    if (isXmlElement(child)) {
      if (!tagName || child.tagName === tagName) {
        results.push(child);
      }
    }
  }

  return results;
}

/**
 * Coerce string value to appropriate type
 */
export function coerceValue(value: string, options: XmlParseOptions = {}): CoercedValue {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };

  if (opts.parseDates) {
    // ISO 8601 date pattern
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  if (opts.parseNumbers) {
    // Check for integer or float
    if (/^-?\d+$/.test(value)) {
      return parseInt(value, 10);
    }
    if (/^-?\d+\.\d+$/.test(value)) {
      return parseFloat(value);
    }
  }

  // Check for boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
}

/**
 * Parse XML element to a plain object
 */
export function parseElementToObject(
  element: XmlElement,
  options: XmlParseOptions = {}
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };

  // Add attributes with @ prefix
  for (const [name, value] of Object.entries(element.attributes)) {
    result[`@${name}`] = coerceValue(value, opts);
  }

  // Track elements with same tag name for array detection
  const childCounts: Record<string, number> = {};
  for (const child of element.children) {
    if (isXmlElement(child)) {
      childCounts[child.tagName] = (childCounts[child.tagName] || 0) + 1;
    }
  }

  // Process children
  for (const child of element.children) {
    if (child.type === 'text' || child.type === 'cdata') {
      // Text content becomes #text
      const text = child.content || '';
      if (text.trim()) {
        result['#text'] = opts.trim ? text.trim() : text;
      }
    } else if (isXmlElement(child)) {
      const childObj = parseElementToObject(child, opts);
      const tagName = child.tagName;

      if (childCounts[tagName]! > 1) {
        // Multiple elements with same tag = array
        if (!result[tagName]) {
          result[tagName] = [];
        }
        (result[tagName] as unknown[]).push(childObj);
      } else {
        result[tagName] = childObj;
      }
    }
  }

  return result;
}
