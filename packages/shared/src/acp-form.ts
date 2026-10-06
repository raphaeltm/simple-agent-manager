import {
  DEFAULT_ACP_INTERACTION_ANSWER_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_ANSWER_STRING_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES,
  DEFAULT_ACP_INTERACTION_OPTION_ID_MAX_CHARS,
  DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS,
} from './acp-interactions';

export interface AcpFormLimits {
  schemaMaxBytes: number;
  propertiesMax: number;
  enumMax: number;
  answerMaxBytes: number;
  stringMaxBytes: number;
  keyMaxChars: number;
  labelMaxChars: number;
}

export const DEFAULT_ACP_FORM_LIMITS: AcpFormLimits = {
  schemaMaxBytes: DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES,
  propertiesMax: DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES,
  enumMax: DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM,
  answerMaxBytes: DEFAULT_ACP_INTERACTION_ANSWER_MAX_BYTES,
  stringMaxBytes: DEFAULT_ACP_INTERACTION_ANSWER_STRING_MAX_BYTES,
  keyMaxChars: DEFAULT_ACP_INTERACTION_OPTION_ID_MAX_CHARS,
  labelMaxChars: DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS,
};

export type AcpFormChoice = {
  const: string;
  title: string;
  description?: string;
  _meta?: { '_claude/askUserQuestionOption': { preview: string } };
};
export type AcpFormField = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: string | number | boolean | string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  enum?: string[];
  oneOf?: AcpFormChoice[];
  items?: { enum?: string[]; anyOf?: AcpFormChoice[]; type?: 'string' };
  _meta?: Record<string, unknown>;
};
export type AcpFormSchema = {
  type: 'object';
  title?: string;
  description?: string;
  properties: Record<string, AcpFormField>;
  required?: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && [...value].length <= max;
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || boundedText(value, max);
}

function optionalUint(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function choices(value: unknown, limits: AcpFormLimits): value is AcpFormChoice[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.enumMax) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    const choice = record(item);
    if (!choice || !onlyKeys(choice, ['const', 'title', 'description', '_meta'])) return false;
    if (!boundedText(choice.const, limits.keyMaxChars) || !boundedText(choice.title, limits.labelMaxChars) ||
        !optionalText(choice.description, limits.schemaMaxBytes) || seen.has(choice.const as string)) return false;
    if (choice._meta !== undefined) {
      const meta = record(choice._meta);
      const preview = meta && record(meta['_claude/askUserQuestionOption']);
      if (!meta || !onlyKeys(meta, ['_claude/askUserQuestionOption']) || !preview ||
          !onlyKeys(preview, ['preview']) || !boundedText(preview.preview, limits.schemaMaxBytes)) return false;
    }
    seen.add(choice.const as string);
    return true;
  });
}

function enumValues(value: unknown, limits: AcpFormLimits): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= limits.enumMax &&
    value.every((item) => boundedText(item, limits.keyMaxChars)) && new Set(value).size === value.length;
}

// These are the only wrapper metadata shapes we can interpret. Unknown metadata
// cancels the request, so a schema constraint can never disappear silently.
function supportedMeta(value: unknown, fieldType: string, limits: AcpFormLimits): boolean {
  if (value === undefined) return true;
  const meta = record(value);
  if (!meta || Object.keys(meta).length !== 1) return false;
  const claude = record(meta._askUserQuestionCustomAnswer);
  if (fieldType === 'string' && claude && onlyKeys(claude, ['questionId', 'isCustomAnswer'])) {
    return boundedText(claude.questionId, limits.keyMaxChars) && claude.isCustomAnswer === true;
  }
  const codex = record(meta.codex);
  if (fieldType === 'string' && codex) {
    return onlyKeys(codex, ['isOther', 'isSecret', 'questionId', 'role']) &&
      (codex.isOther === undefined || typeof codex.isOther === 'boolean') &&
      (codex.isSecret === undefined || typeof codex.isSecret === 'boolean') &&
      (codex.questionId === undefined || boundedText(codex.questionId, limits.keyMaxChars)) &&
      (codex.role === undefined || codex.role === 'user_note');
  }
  return false;
}

function validField(value: unknown, limits: AcpFormLimits): value is AcpFormField {
  const f = record(value);
  if (!f || !optionalText(f.title, limits.labelMaxChars) || !optionalText(f.description, limits.schemaMaxBytes) ||
      !supportedMeta(f._meta, String(f.type), limits)) return false;
  const base = ['type', 'title', 'description', 'default', '_meta'];
  switch (f.type) {
    case 'string': {
      if (!onlyKeys(f, [...base, 'minLength', 'maxLength', 'enum', 'oneOf'])) return false;
      if (!optionalUint(f.minLength) || !optionalUint(f.maxLength) ||
          (typeof f.minLength === 'number' && typeof f.maxLength === 'number' && f.minLength > f.maxLength)) return false;
      if (f.enum !== undefined && f.oneOf !== undefined) return false;
      if (f.enum !== undefined && !enumValues(f.enum, limits)) return false;
      if (f.oneOf !== undefined && !choices(f.oneOf, limits)) return false;
      if (f.default !== undefined && typeof f.default !== 'string') return false;
      break;
    }
    case 'number':
    case 'integer':
      if (!onlyKeys(f, [...base, 'minimum', 'maximum']) ||
          (f.minimum !== undefined && (typeof f.minimum !== 'number' || !Number.isFinite(f.minimum))) ||
          (f.maximum !== undefined && (typeof f.maximum !== 'number' || !Number.isFinite(f.maximum))) ||
          (f.minimum !== undefined && f.maximum !== undefined && f.minimum > f.maximum) ||
          (f.default !== undefined && (typeof f.default !== 'number' || !Number.isFinite(f.default) ||
            (f.type === 'integer' && !Number.isSafeInteger(f.default))))) return false;
      break;
    case 'boolean':
      if (!onlyKeys(f, base) || (f.default !== undefined && typeof f.default !== 'boolean')) return false;
      break;
    case 'array': {
      if (!onlyKeys(f, [...base, 'items', 'minItems', 'maxItems']) ||
          !optionalUint(f.minItems) || !optionalUint(f.maxItems) ||
          (typeof f.minItems === 'number' && typeof f.maxItems === 'number' && f.minItems > f.maxItems)) return false;
      const items = record(f.items);
      if (!items || !onlyKeys(items, ['type', 'enum', 'anyOf']) ||
          (items.type !== undefined && items.type !== 'string') ||
          (items.enum === undefined) === (items.anyOf === undefined)) return false;
      if (items.enum !== undefined && !enumValues(items.enum, limits)) return false;
      if (items.anyOf !== undefined && !choices(items.anyOf, limits)) return false;
      if (f.default !== undefined && (!Array.isArray(f.default) ||
          !f.default.every((item) => typeof item === 'string'))) return false;
      break;
    }
    default:
      return false;
  }
  return f.default === undefined || validValue(f as AcpFormField, f.default, limits);
}

function validValue(field: AcpFormField, value: unknown, limits: AcpFormLimits): boolean {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' && utf8Bytes(value) <= limits.stringMaxBytes &&
        (field.minLength === undefined || [...value].length >= field.minLength) &&
        (field.maxLength === undefined || [...value].length <= field.maxLength) &&
        (field.enum === undefined || field.enum.includes(value)) &&
        (field.oneOf === undefined || field.oneOf.some((choice) => choice.const === value));
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) &&
        (field.type !== 'integer' || Number.isSafeInteger(value)) &&
        (field.minimum === undefined || value >= field.minimum) &&
        (field.maximum === undefined || value <= field.maximum);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array': {
      const allowed = field.items?.enum ?? field.items?.anyOf?.map((choice) => choice.const);
      return Array.isArray(value) && value.length <= limits.enumMax &&
        (field.minItems === undefined || value.length >= field.minItems) &&
        (field.maxItems === undefined || value.length <= field.maxItems) &&
        new Set(value).size === value.length && value.every((item) =>
          typeof item === 'string' && utf8Bytes(item) <= limits.stringMaxBytes &&
          allowed?.includes(item));
    }
  }
}

export function validateAcpFormSchema(value: unknown, limits = DEFAULT_ACP_FORM_LIMITS): value is AcpFormSchema {
  const schema = record(value);
  if (!schema || !onlyKeys(schema, ['type', 'title', 'description', 'properties', 'required']) ||
      schema.type !== 'object' || !optionalText(schema.title, limits.labelMaxChars) ||
      !optionalText(schema.description, limits.schemaMaxBytes)) return false;
  if (utf8Bytes(JSON.stringify(value)) > limits.schemaMaxBytes) return false;
  const properties = record(schema.properties);
  if (!properties || Object.keys(properties).length === 0 || Object.keys(properties).length > limits.propertiesMax ||
      Object.keys(properties).some((key) => !/^[A-Za-z0-9_.-]+$/u.test(key) || key.length > limits.keyMaxChars || key === '__proto__' ||
        !validField(properties[key], limits))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((key: unknown) => typeof key !== 'string' || !Object.hasOwn(properties, key)))) return false;
  return true;
}

export function validateAcpFormAnswer(
  schema: AcpFormSchema,
  content: unknown,
  limits = DEFAULT_ACP_FORM_LIMITS
): content is Record<string, string | number | boolean | string[]> {
  const answer = record(content);
  if (!answer || Object.keys(answer).length === 0 || utf8Bytes(JSON.stringify(content)) > limits.answerMaxBytes) return false;
  if (Object.keys(answer).some((key) => {
    const field = schema.properties[key];
    return !field || !validValue(field, answer[key], limits);
  })) return false;
  return (schema.required ?? []).every((key) => Object.hasOwn(answer, key));
}
