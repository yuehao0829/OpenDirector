/**
 * XML Serializer - Converts JavaScript objects to XML strings
 */

import type { XmlElement, XmlNode, XmlSerializeOptions } from './types';
import { isXmlElement } from './parser';

const DEFAULT_SERIALIZE_OPTIONS: XmlSerializeOptions = {
  pretty: true,
  indent: '  ',
  declaration: true,
  encoding: 'UTF-8',
};

/**
 * Serialize XmlElement to XML string
 */
export function serializeXml(element: XmlElement, options: XmlSerializeOptions = {}): string {
  const opts = { ...DEFAULT_SERIALIZE_OPTIONS, ...options };
  const lines: string[] = [];

  // Add XML declaration
  if (opts.declaration) {
    lines.push(`<?xml version="1.0" encoding="${opts.encoding}"?>`);
  }

  if (opts.doctype) {
    lines.push(opts.doctype);
  }

  // Serialize root element
  const elementStr = serializeElement(element, 0, opts);
  if (Array.isArray(elementStr)) {
    lines.push(...elementStr);
  } else {
    lines.push(elementStr);
  }

  return lines.join('\n');
}

/**
 * Serialize an element to string(s)
 */
function serializeElement(
  element: XmlElement,
  depth: number,
  options: XmlSerializeOptions
): string | string[] {
  const indent = options.pretty ? options.indent!.repeat(depth) : '';
  const childIndent = options.pretty ? options.indent!.repeat(depth + 1) : '';

  // Build opening tag
  const attrStr = serializeAttributes(element.attributes);
  const openTag = attrStr ? `<${element.tagName} ${attrStr}>` : `<${element.tagName}>`;

  // Check if element has children
  const significantChildren = element.children.filter(
    (c) => c.type !== 'text' || (c.content && c.content.trim())
  );

  if (significantChildren.length === 0) {
    // Self-closing tag
    return options.pretty
      ? `${indent}<${element.tagName}${attrStr ? ' ' + attrStr : ''}/>`
      : `<${element.tagName}${attrStr ? ' ' + attrStr : ''}/>`;
  }

  // Check if only text content
  const hasOnlyText = significantChildren.every((c) => c.type === 'text' || c.type === 'cdata');

  if (hasOnlyText && significantChildren.length === 1) {
    // Inline text content
    const textContent = serializeNode(significantChildren[0]!, options);
    return options.pretty
      ? `${indent}${openTag}${textContent}</${element.tagName}>`
      : `${openTag}${textContent}</${element.tagName}>`;
  }

  // Has child elements - format with newlines
  const lines: string[] = [];

  if (options.pretty) {
    lines.push(`${indent}${openTag}`);
  } else {
    lines.push(openTag);
  }

  for (const child of significantChildren) {
    if (isXmlElement(child)) {
      const childStr = serializeElement(child, depth + 1, options);
      if (Array.isArray(childStr)) {
        lines.push(...childStr);
      } else {
        lines.push(childStr);
      }
    } else if (child.type === 'text') {
      if (options.pretty) {
        lines.push(`${childIndent}${child.content}`);
      } else {
        lines.push(child.content || '');
      }
    } else if (child.type === 'cdata') {
      if (options.pretty) {
        lines.push(`${childIndent}<![CDATA[${child.content}]]>`);
      } else {
        lines.push(`<![CDATA[${child.content}]]>`);
      }
    }
  }

  lines.push(options.pretty ? `${indent}</${element.tagName}>` : `</${element.tagName}>`);

  return lines;
}

/**
 * Serialize a single node
 */
function serializeNode(node: XmlNode, _options?: XmlSerializeOptions): string {
  if (node.type === 'text') {
    return escapeXml(node.content || '');
  }
  if (node.type === 'cdata') {
    return `<![CDATA[${node.content}]]>`;
  }
  // Element handled separately
  return '';
}

/**
 * Serialize attributes to string
 */
function serializeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(' ');
}

/**
 * Escape special characters for XML text content
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape attribute value
 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create an XmlElement builder
 */
export function createElement(tagName: string, attributes: Record<string, string | number | boolean> = {}): XmlElementBuilder {
  return new XmlElementBuilder(tagName, attributes);
}

/**
 * Builder for creating XmlElements
 */
class XmlElementBuilder {
  private element: XmlElement;

  constructor(tagName: string, attributes: Record<string, string | number | boolean> = {}) {
    const stringAttrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      stringAttrs[key] = String(value);
    }

    this.element = {
      type: 'element',
      tagName,
      attributes: stringAttrs,
      children: [],
    };
  }

  attr(name: string, value: string | number | boolean): this {
    this.element.attributes[name] = String(value);
    return this;
  }

  text(content: string): this {
    this.element.children.push({
      type: 'text',
      content,
    });
    return this;
  }

  cdata(content: string): this {
    this.element.children.push({
      type: 'cdata',
      content,
    });
    return this;
  }

  child(element: XmlElement): this {
    this.element.children.push(element);
    return this;
  }

  children(...elements: XmlElement[]): this {
    this.element.children.push(...elements);
    return this;
  }

  build(): XmlElement {
    return this.element;
  }
}

/**
 * Helper to create a simple text element
 */
export function textElement(tagName: string, text: string, attributes: Record<string, string | number | boolean> = {}): XmlElement {
  return createElement(tagName, attributes).text(text).build();
}

/**
 * Helper to create a simple element with only attributes
 */
export function attrElement(tagName: string, attributes: Record<string, string | number | boolean>): XmlElement {
  return createElement(tagName, attributes).build();
}

// Export builder for external use
export { XmlElementBuilder };
