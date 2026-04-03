export type DebugJsonOptions = {
  omitUndefined?: boolean;
  includeTypeName?: boolean;
};

const OMIT_VALUE = Symbol('debug-json-omit');

const DEFAULT_DEBUG_JSON_OPTIONS: Required<DebugJsonOptions> = {
  omitUndefined: true,
  includeTypeName: false,
};

type NormalizeContext = {
  inArray: boolean;
  isRoot: boolean;
};

function resolveDebugJsonOptions(options?: DebugJsonOptions): Required<DebugJsonOptions> {
  return {
    ...DEFAULT_DEBUG_JSON_OPTIONS,
    ...(options || {}),
  };
}

function normalizeDebugJsonInternal(
  value: unknown,
  seen: WeakSet<object>,
  options: Required<DebugJsonOptions>,
  context: NormalizeContext,
): unknown {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    if (!options.omitUndefined || context.isRoot) {
      return undefined;
    }
    return context.inArray ? null : OMIT_VALUE;
  }

  const valueType = typeof value;

  if (valueType === 'bigint') {
    return value.toString();
  }

  if (valueType === 'function') {
    return `[Function ${(value as Function).name || 'anonymous'}]`;
  }

  if (valueType === 'symbol') {
    return String(value);
  }

  if (valueType !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack || '[stack unavailable]',
    };
  }

  if (value instanceof Map) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of value.entries()) {
      const normalizedValue = normalizeDebugJsonInternal(entryValue, seen, options, {
        inArray: false,
        isRoot: false,
      });
      if (normalizedValue === OMIT_VALUE) {
        continue;
      }
      output[String(entryKey)] = normalizedValue;
    }
    seen.delete(value);
    return output;
  }

  if (value instanceof Set) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output = Array.from(value, (item) =>
      normalizeDebugJsonInternal(item, seen, options, {
        inArray: true,
        isRoot: false,
      }),
    );
    seen.delete(value);
    return output;
  }

  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength,
    };
  }

  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor?.name || 'TypedArray',
      values: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output = value.map((item) =>
      normalizeDebugJsonInternal(item, seen, options, {
        inArray: true,
        isRoot: false,
      }),
    );
    seen.delete(value);
    return output;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (!options.includeTypeName && entryKey === '$typeName') {
      continue;
    }
    const normalizedValue = normalizeDebugJsonInternal(entryValue, seen, options, {
      inArray: false,
      isRoot: false,
    });
    if (normalizedValue === OMIT_VALUE) {
      continue;
    }
    output[entryKey] = normalizedValue;
  }
  seen.delete(value);
  return output;
}

export function normalizeDebugJsonValue<T>(value: T, options?: DebugJsonOptions): T {
  return normalizeDebugJsonInternal(value, new WeakSet<object>(), resolveDebugJsonOptions(options), {
    inArray: false,
    isRoot: true,
  }) as T;
}

export function stringifyDebugJson(value: unknown, options?: DebugJsonOptions): string {
  if (value === undefined) {
    return 'undefined';
  }

  try {
    return JSON.stringify(normalizeDebugJsonValue(value, options), null, 2);
  } catch (_) {
    return String(value);
  }
}
