export function fitTextarea(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

export function autosizeTextarea(node: HTMLTextAreaElement, _value = '') {
  const fit = () => fitTextarea(node);
  fit();
  node.addEventListener('input', fit);
  return {
    update: fit,
    destroy() {
      node.removeEventListener('input', fit);
    }
  };
}
