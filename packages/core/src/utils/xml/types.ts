/**
 * XML serialization/parsing type definitions
 */

export interface XmlAttribute {
  name: string;
  value: string | number | boolean;
}

export interface XmlNode {
  type: 'element' | 'text' | 'cdata';
  tagName?: string;
  attributes?: Record<string, string>;
  children?: XmlNode[];
  content?: string;
}

export interface XmlElement extends XmlNode {
  type: 'element';
  tagName: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export interface XmlParseOptions {
  /**
   * Trim text content
   * @default true
   */
  trim?: boolean;

  /**
   * Parse numeric strings to numbers
   * @default true
   */
  parseNumbers?: boolean;

  /**
   * Parse date strings to Date objects
   * @default true
   */
  parseDates?: boolean;

  /**
   * Ignore comments
   * @default true
   */
  ignoreComments?: boolean;
}

export interface XmlSerializeOptions {
  /**
   * Pretty print with indentation
   * @default true
   */
  pretty?: boolean;

  /**
   * Indentation string (when pretty is true)
   * @default '  '
   */
  indent?: string;

  /**
   * Include XML declaration
   * @default true
   */
  declaration?: boolean;

  /**
   * Declaration encoding
   * @default 'UTF-8'
   */
  encoding?: string;

  /**
   * DOCTYPE declaration to insert after XML declaration
   * e.g. '<!DOCTYPE xmeml>'
   */
  doctype?: string;
}

/**
 * Base interface for XML-serializable objects
 */
export interface XmlSerializable {
  toXml(): XmlElement;
  fromXml(element: XmlElement): void;
}

/**
 * Type coercion result
 */
export type CoercedValue = string | number | boolean | Date | null;

/**
 * Element descriptor for schema-based parsing
 */
export interface ElementDescriptor {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  attributes?: Record<string, 'string' | 'number' | 'boolean'>;
  children?: ElementDescriptor[];
  array?: boolean;
  required?: boolean;
  defaultValue?: unknown;
}
