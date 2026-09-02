/**
 * Theme control. The applied theme was already committed before first paint by
 * the inline bootstrap in BaseLayout; this module only keeps the radio group in
 * sync with the stored preference and reacts to changes.
 */
const STORAGE_KEY = 'transmogrify:theme';
type Choice = 'auto' | 'light' | 'dark';

const root = document.documentElement;
const group = document.querySelector<HTMLFieldSetElement>('[data-theme-toggle]');

function readStored(): Choice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Kept in memory too, so the control still behaves when storage is blocked. */
let choice: Choice = readStored();

const systemLight = window.matchMedia('(prefers-color-scheme: light)');

function apply(): void {
  root.dataset.theme = choice === 'auto' ? (systemLight.matches ? 'light' : 'dark') : choice;
}

function persist(next: Choice): void {
  choice = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A blocked or full store is not an error worth surfacing; the in-memory
    // choice still drives this page.
  }
  apply();
}

if (group) {
  for (const input of group.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    input.checked = input.value === choice;
    input.addEventListener('change', () => {
      if (input.checked) persist(input.value as Choice);
    });
  }
}

systemLight.addEventListener('change', () => {
  if (choice === 'auto') apply();
});

apply();
