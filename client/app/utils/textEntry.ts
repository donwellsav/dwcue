// Whether an element takes typed text, so keyboard shortcuts must leave its
// keys alone. A slider, checkbox or button input does not: after the operator
// drags a progress bar or ticks a box, Space must still run GO. Any other
// input type counts as a text field.
const NOT_TYPED_INTO = new Set([
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden',
]);

export function isTextEntry(element: Element | null | undefined): boolean {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable) return true;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !NOT_TYPED_INTO.has(((element as HTMLInputElement).type || 'text').toLowerCase());
}
