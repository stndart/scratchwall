export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  // Older webviews and HTTP development origins lack the Clipboard API.
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement('textarea');
  input.value = value;
  input.style.cssText = 'position:fixed;top:0;left:-9999px';
  input.setAttribute('readonly', '');
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

export function filesFromClipboard(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File) => {
    const key = `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) add(file);
  }
  // Both collections describe the same clipboard payload. Some browsers return
  // fresh File objects (with different names/timestamps) for each collection.
  // Prefer items; only use files when no readable file items were provided.
  if (!files.length) for (const file of Array.from(data.files ?? [])) add(file);
  return files;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (
    element.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  )
    return true;
  const editable = element.contentEditable;
  return (
    element.isContentEditable ||
    editable === 'true' ||
    editable === 'plaintext-only'
  );
}
