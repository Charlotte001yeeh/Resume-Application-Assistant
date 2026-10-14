/* Test helper: build page field descriptors */
export function desc(overrides = {}) {
  const signals = {
    label: '',
    name: '',
    id: '',
    placeholder: '',
    ariaLabel: '',
    autocomplete: '',
    nearby: '',
    options: [],
    maxLength: 0,
    ...(overrides.signals || {}),
  };
  return {
    id: overrides.id || `f-${Math.random().toString(36).slice(2, 7)}`,
    kind: overrides.kind || 'input',
    inputType: overrides.inputType || 'text',
    signals,
    required: !!overrides.required,
    filled: overrides.filled ?? !!overrides.value,
    value: overrides.value || '',
    el: overrides.el || null,
    elements: overrides.elements || null,
  };
}

export function selectDesc(label, options, extra = {}) {
  return desc({
    kind: 'select',
    inputType: 'select',
    signals: {
      label,
      options: options.map((o, i) => (typeof o === 'string' ? { value: `v${i}`, text: o } : o)),
      ...(extra.signals || {}),
    },
    ...extra,
  });
}

export function radioDesc(label, options, extra = {}) {
  return desc({
    kind: 'radio-group',
    inputType: 'radio',
    signals: {
      label,
      options: options.map((o, i) => (typeof o === 'string' ? { value: `v${i}`, text: o } : o)),
      ...(extra.signals || {}),
    },
    ...extra,
  });
}
