/* global document, getComputedStyle, innerHeight, innerWidth, matchMedia, window */
// Injected into the gate's pages (scripts/ui-checks.mjs); ported from the
// template's spike #120 (scripts/contrast.js). Measures the contrast of what
// is rendered, as WCAG 2.2 asks. Text: 4.5:1, or 3:1 when large (1.4.3).
// Non-text (1.4.11): 3:1 for icons in controls, boundaries of fields and
// focus indicators against the adjacent colour. Disabled controls and content
// covered by a modal layer are exempt. Colours are resolved through a canvas,
// so oklch, color-mix and transparency are measured as the browser paints
// them. The displayed value and the placeholder of fields count as text. This
// measures the states a run reaches; it is not a complete accessibility
// validation. Its controls in ui-checks.mjs check it against known failures.
// `root` limits it to one element and its content (hover, pressed, focus).
function uiContrast(root = document.body) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.globalCompositeOperation = 'copy';
  const rgba = (css) => {
    if (!css || css === 'transparent') return [0, 0, 0, 0];
    g.fillStyle = '#000';
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    return [r, gg, b, a / 255];
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const lum = ([r, gg, b]) => {
    const f = (c) =>
      (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const hex = (c) =>
    '#' +
    c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('');
  // The opaque colour behind an element: its own and its ancestors'
  // backgrounds composited from the page upwards.
  const backdrop = (el, includeSelf = true) => {
    const layers = [];
    for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) {
      const bg = rgba(getComputedStyle(n).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let color = rgba(
      getComputedStyle(document.documentElement).backgroundColor,
    );
    if (color[3] < 1)
      color = matchMedia('(prefers-color-scheme: dark)').matches
        ? [18, 18, 18, 1]
        : [255, 255, 255, 1];
    for (const layer of layers.reverse()) color = over(layer, color);
    return color;
  };
  const opacity = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement)
      o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el.contains(hit) || hit.contains(el));
  };
  const disabled = (el) =>
    !!el.closest(':disabled, [aria-disabled="true"], [data-disabled]');
  const describe = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 32);
    const ui = el.closest('[data-sempods-ui]')?.getAttribute('data-sempods-ui');
    const slot = el.closest('[data-slot]')?.getAttribute('data-slot');
    return `${el.tagName.toLowerCase()}${ui ? `[sdk:${ui}]` : ''}${slot ? `[${slot}]` : ''} "${t}"`;
  };
  const results = [];
  const record = (kind, el, fg, bg, required) => {
    const r = ratio(fg, bg);
    results.push({
      kind,
      what: describe(el),
      ratio: Math.round(r * 100) / 100,
      required,
      pass: r >= required - 0.005,
      fg: hex(fg),
      bg: hex(bg),
    });
  };
  const elements =
    root === document.body
      ? document.querySelectorAll('body *')
      : [root, ...root.querySelectorAll('*')];
  for (const el of elements) {
    if (!visible(el) || disabled(el)) continue;
    const s = getComputedStyle(el);
    // A field's value and placeholder are not text nodes; measure them as
    // painted on the field's own background.
    if (
      el.matches(
        'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=color]), textarea',
      )
    ) {
      const bg = backdrop(el);
      const size = parseFloat(s.fontSize);
      const large =
        size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      if (el.value) {
        const c = rgba(s.color);
        c[3] *= opacity(el);
        record('field-value', el, over(c, bg), bg, large ? 3 : 4.5);
      } else if (el.placeholder) {
        const c = rgba(getComputedStyle(el, '::placeholder').color);
        c[3] *=
          opacity(el) *
          Number(getComputedStyle(el, '::placeholder').opacity || 1);
        record('placeholder', el, over(c, bg), bg, large ? 3 : 4.5);
      }
    }
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim(),
    );
    if (ownText && !el.closest('.sr-only')) {
      const bg = backdrop(el);
      const c = rgba(s.color);
      c[3] *= opacity(el);
      const size = parseFloat(s.fontSize);
      const large =
        size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      record(
        large ? 'text-large' : 'text',
        el,
        over(c, bg),
        bg,
        large ? 3 : 4.5,
      );
    }
    if (el.tagName === 'svg' && !el.closest('[aria-hidden="true"]:not(svg)')) {
      const host = el.closest(
        'button, a, [role=menuitem], [role=menuitemradio]',
      );
      if (host && !disabled(host)) {
        const bg = backdrop(host);
        const c = rgba(s.stroke !== 'none' ? s.stroke : s.color);
        c[3] *= opacity(el);
        record('icon', host, over(c, bg), bg, 3);
      }
    }
    if (
      el.matches(
        'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select',
      )
    ) {
      const bg = backdrop(el, false);
      const border = rgba(s.borderTopColor);
      if (parseFloat(s.borderTopWidth) > 0 && border[3] > 0)
        record('field-boundary', el, over(border, bg), bg, 3);
      else
        results.push({
          kind: 'field-boundary',
          what: describe(el),
          ratio: 0,
          required: 3,
          pass: false,
          note: 'no border',
        });
    }
  }
  return results;
}

/** The focus indicator of the focused element against what is behind it. */
function uiFocusIndicator() {
  const el = document.activeElement;
  if (
    !el ||
    el === document.body ||
    el.matches('[role=dialog], [role=alertdialog], dialog')
  )
    return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.globalCompositeOperation = 'copy';
  const rgba = (css) => {
    g.fillStyle = '#000';
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    return [r, gg, b, a / 255];
  };
  const s = getComputedStyle(el);
  let css = null;
  let source = '';
  if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) {
    css = s.outlineColor;
    source = `outline ${s.outlineWidth}`;
  } else if (s.boxShadow !== 'none') {
    // The first visible shadow with a spread: Tailwind's ring.
    const shadows = s.boxShadow.matchAll(
      /((?:rgba?|oklch|oklab|color|lab|lch)\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g,
    );
    for (const match of shadows)
      if (parseFloat(match[5]) > 0 && rgba(match[1])[3] > 0) {
        css = match[1];
        source = `ring ${match[5]}px`;
        break;
      }
  }
  const lum = ([r, gg, b]) => {
    const f = (c) =>
      (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b);
  };
  let bg = [255, 255, 255, 1];
  for (let n = el.parentElement; n; n = n.parentElement) {
    const c = rgba(getComputedStyle(n).backgroundColor);
    if (c[3] >= 1) {
      bg = c;
      break;
    }
  }
  const name = (el.getAttribute('aria-label') || el.textContent || el.tagName)
    .trim()
    .slice(0, 32);
  if (!css)
    return { what: name, ratio: 0, pass: false, note: 'no visible indicator' };
  const c = rgba(css);
  const fg = [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3]));
  const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  const r = (l1 + 0.05) / (l2 + 0.05);
  return { what: name, source, ratio: Math.round(r * 100) / 100, pass: r >= 3 };
}

window.uiContrast = uiContrast;
window.uiFocusIndicator = uiFocusIndicator;
