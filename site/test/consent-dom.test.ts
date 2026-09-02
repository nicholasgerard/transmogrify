import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHTML } from 'linkedom';

test('the privacy link cancels a pending hide and reopens the consent dialog', async () => {
  const { document, window } = parseHTML(`<!doctype html>
    <html><head></head><body data-analytics-id="G-TEST123XYZ">
      <a href="/privacy#analytics" data-privacy-choices>Privacy choices</a>
      <span data-privacy-state></span>
      <section id="consent-dialog" hidden tabindex="-1">
        <button data-consent="allow">Allow</button>
        <button data-consent="deny">Deny</button>
      </section>
    </body></html>`);

  const stored = new Map<string, string>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const localStorage = {
    getItem(key: string) { return stored.get(key) ?? null; },
    setItem(key: string, value: string) { stored.set(key, value); },
    removeItem(key: string) { stored.delete(key); },
  };
  Object.defineProperties(window, {
    matchMedia: { value: () => ({ matches: false }), configurable: true },
    setTimeout: {
      value: (callback: () => void) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      configurable: true,
    },
    clearTimeout: {
      value: (id: number) => { timers.delete(id); },
      configurable: true,
    },
  });

  const replacements: Array<[string, PropertyDescriptor | undefined]> = [];
  const location = { hostname: 'transmogrify.sh', pathname: '/', protocol: 'https:' };
  for (const [name, value] of Object.entries({
    document,
    window,
    navigator: window.navigator,
    location,
    localStorage,
  })) {
    replacements.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  try {
    await import(`../src/scripts/consent.ts?dom=${Date.now()}`);
    const dialog = document.getElementById('consent-dialog')!;
    const control = document.querySelector<HTMLAnchorElement>('[data-privacy-choices]')!;
    assert.equal(control.getAttribute('href'), '/privacy#analytics');
    assert.equal(dialog.hidden, false, 'an unanswered visitor sees the prompt');
    assert.equal(document.querySelector('script[src*="googletagmanager.com"]'), null);

    dialog.querySelector<HTMLButtonElement>('[data-consent="allow"]')!.click();
    assert.equal(timers.size, 1, 'the closing transition schedules one hide');
    assert.ok(document.querySelector('script[src*="googletagmanager.com"]'));

    control.click();
    assert.equal(timers.size, 0, 'reopening cancels the stale hide callback');
    assert.equal(dialog.hidden, false);
    assert.equal(dialog.dataset.open, 'true');

    Object.defineProperty(globalThis.navigator, 'globalPrivacyControl', {
      value: true,
      configurable: true,
    });
    const gpcClick = new window.Event('click', { bubbles: true, cancelable: true });
    control.dispatchEvent(gpcClick);
    assert.equal(gpcClick.defaultPrevented, false, 'GPC keeps the real privacy-page link active');
    assert.equal(dialog.dataset.open, undefined);
  } finally {
    for (const [name, descriptor] of replacements.reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
