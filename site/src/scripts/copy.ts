/**
 * Copy-to-clipboard for the start prompt and the shell snippets.
 *
 * Clipboard access fails in real conditions — an insecure origin, a denied
 * permission, an embedded webview. When it does, the text is selected instead
 * so the visitor can press the platform copy shortcut, and both the button and
 * the live region say what happened.
 */
const RESET_MS = 2600;

function announce(root: Element, message: string, tone: 'ok' | 'error'): void {
  const status =
    root.parentElement?.querySelector<HTMLElement>('[data-copy-status]') ??
    document.querySelector<HTMLElement>('[data-copy-status]');
  if (!status) return;
  status.dataset.tone = tone;
  // Re-assert the text so a repeated copy is announced again.
  status.textContent = '';
  window.setTimeout(() => {
    status.textContent = message;
  }, 30);
}

function selectText(node: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to manual selection.
  }
  return false;
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-button]')) {
  const targetId = button.dataset.copyTarget;
  const target = targetId ? document.getElementById(targetId) : null;
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const original = label?.textContent ?? 'Copy';
  const quiet = button.dataset.copyQuiet === 'true';
  const root = button.closest('[data-copy-root]') ?? button;
  let timer: number | undefined;

  if (!target) continue;

  button.addEventListener('click', async () => {
    const text = target.textContent ?? '';
    const copied = await writeClipboard(text);

    window.clearTimeout(timer);

    if (copied) {
      button.dataset.state = 'copied';
      if (label) label.textContent = 'Copied';
      if (!quiet) announce(root, 'Prompt copied to your clipboard.', 'ok');
    } else {
      const selected = selectText(target);
      button.dataset.state = 'manual';
      if (label) label.textContent = selected ? 'Selected' : 'Copy failed';
      announce(
        root,
        selected
          ? 'Clipboard access was blocked. The text is selected — copy it with your keyboard.'
          : 'Clipboard access was blocked. Select the text below and copy it with your keyboard.',
        'error',
      );
    }

    timer = window.setTimeout(() => {
      delete button.dataset.state;
      if (label) label.textContent = original;
    }, RESET_MS);
  });
}
