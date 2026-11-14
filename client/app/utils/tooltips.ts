const titled = '[title]:not([title=""])';
const emptyTitle = '[title=""]';

export function suppressTooltips(root: HTMLElement): () => void {
  const hidden = new WeakMap<Element, string>();
  const hide = (element: Element) => {
    const title = element.getAttribute('title');
    if (!title) return;
    hidden.set(element, title);
    // An empty title also blocks inherited hints and lets Vue remove the attribute.
    element.setAttribute('title', '');
  };
  const restore = (element: Element) => {
    const title = hidden.get(element);
    if (title && element.getAttribute('title') === '') element.setAttribute('title', title);
    hidden.delete(element);
  };
  const apply = (records: MutationRecord[]) => {
    observer.disconnect();
    const edited = new Set(records.filter(record => record.type === 'attributes').map(record => record.target as Element));
    for (const element of edited) {
      hidden.delete(element);
      if (root.contains(element)) hide(element);
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !root.contains(node)) continue;
        hide(node);
        node.querySelectorAll(titled).forEach(hide);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element) || root.contains(node)) continue;
        restore(node);
        node.querySelectorAll(emptyTitle).forEach(restore);
      }
    }
  };
  const options = { subtree: true, childList: true, attributeFilter: ['title'] };
  const observer = new MutationObserver(records => {
    apply(records);
    observer.observe(root, options);
  });
  hide(root);
  root.querySelectorAll(titled).forEach(hide);
  observer.observe(root, options);
  return () => {
    apply(observer.takeRecords());
    restore(root);
    root.querySelectorAll(emptyTitle).forEach(restore);
  };
}
