import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyticsCookieNames,
  cookieDomainsFor,
  decideConsent,
  type BrowserSignals,
} from '../src/lib/consent.ts';

const noSignals: BrowserSignals = { gpc: false, dnt: false };
const ID = 'G-ABC123XYZ';

describe('decideConsent', () => {
  test('with no measurement ID, analytics does not exist and nobody is asked', () => {
    const decision = decideConsent({ measurementId: undefined, stored: null, signals: noSignals });
    assert.equal(decision.state, 'unavailable');
    assert.equal(decision.analyticsEnabled, false);
    assert.equal(decision.showPrompt, false);
    assert.match(decision.statusText, /not configured/);
  });

  test('an empty or whitespace measurement ID is treated as absent', () => {
    for (const measurementId of ['', '   ', null]) {
      const decision = decideConsent({ measurementId, stored: null, signals: noSignals });
      assert.equal(decision.state, 'unavailable', `for ${JSON.stringify(measurementId)}`);
    }
  });

  test('an unanswered visitor is asked, and nothing loads meanwhile', () => {
    const decision = decideConsent({ measurementId: ID, stored: null, signals: noSignals });
    assert.equal(decision.state, 'unset');
    assert.equal(decision.analyticsEnabled, false);
    assert.equal(decision.showPrompt, true);
  });

  test('consent is required worldwide — no geography is consulted', () => {
    // The decision takes no locale, region, or timezone input at all, which is
    // the point: there is no code path that can enable analytics by location.
    const decision = decideConsent({ measurementId: ID, stored: null, signals: noSignals });
    assert.equal(decision.analyticsEnabled, false);
  });

  test('granted consent enables analytics and hides the prompt', () => {
    const decision = decideConsent({ measurementId: ID, stored: 'granted', signals: noSignals });
    assert.equal(decision.state, 'granted');
    assert.equal(decision.analyticsEnabled, true);
    assert.equal(decision.showPrompt, false);
    assert.match(decision.controlLabel, /analytics on/);
  });

  test('declined consent stays declined without re-asking', () => {
    const decision = decideConsent({ measurementId: ID, stored: 'denied', signals: noSignals });
    assert.equal(decision.state, 'denied');
    assert.equal(decision.analyticsEnabled, false);
    assert.equal(decision.showPrompt, false);
    assert.match(decision.controlLabel, /analytics off/);
  });

  test('Global Privacy Control overrides a stored grant', () => {
    const decision = decideConsent({
      measurementId: ID,
      stored: 'granted',
      signals: { gpc: true, dnt: false },
    });
    assert.equal(decision.state, 'signal');
    assert.equal(decision.analyticsEnabled, false);
    assert.equal(decision.showPrompt, false);
    assert.match(decision.statusText, /Global Privacy Control/);
  });

  test('Do Not Track keeps analytics off and explains the state', () => {
    const decision = decideConsent({
      measurementId: ID,
      stored: null,
      signals: { gpc: false, dnt: true },
    });
    assert.equal(decision.state, 'signal');
    assert.equal(decision.showPrompt, false);
    assert.match(decision.statusText, /Do Not Track/);
  });

  test('a privacy signal is never overridden by reopening the choice', () => {
    const decision = decideConsent({
      measurementId: ID,
      stored: null,
      signals: { gpc: true, dnt: false },
      reopened: true,
    });
    assert.equal(decision.showPrompt, false);
    assert.equal(decision.analyticsEnabled, false);
  });

  test('reopening lets a visitor revisit either answer', () => {
    for (const stored of ['granted', 'denied'] as const) {
      const decision = decideConsent({ measurementId: ID, stored, signals: noSignals, reopened: true });
      assert.equal(decision.showPrompt, true, `reopen from ${stored}`);
      assert.equal(decision.analyticsEnabled, false, `reopen from ${stored} must not keep sending`);
      assert.match(decision.controlLabel, stored === 'granted' ? /analytics on/ : /analytics off/);
    }
  });

  test('no state ever both loads analytics and shows the prompt', () => {
    const stored = [null, 'granted', 'denied'] as const;
    const signals = [
      { gpc: false, dnt: false },
      { gpc: true, dnt: false },
      { gpc: false, dnt: true },
    ];
    for (const s of stored) {
      for (const signal of signals) {
        for (const reopened of [false, true]) {
          const d = decideConsent({ measurementId: ID, stored: s, signals: signal, reopened });
          assert.ok(!(d.analyticsEnabled && d.showPrompt), `contradiction for ${s}/${JSON.stringify(signal)}`);
          if (d.showPrompt) assert.equal(d.analyticsEnabled, false);
        }
      }
    }
  });

  test('every decision carries a control label and a status sentence', () => {
    for (const s of [null, 'granted', 'denied'] as const) {
      const d = decideConsent({ measurementId: ID, stored: s, signals: noSignals });
      assert.ok(d.controlLabel.length > 0);
      assert.ok(d.statusText.length > 10);
    }
  });
});

describe('analyticsCookieNames', () => {
  test('covers the cookies GA4 sets from the browser', () => {
    const names = analyticsCookieNames('G-ABC123XYZ');
    assert.ok(names.includes('_ga'));
    assert.ok(names.includes('_ga_ABC123XYZ'));
    assert.ok(names.includes('_gid'));
    assert.equal(new Set(names).size, names.length, 'no duplicates');
  });
});

describe('cookieDomainsFor', () => {
  test('targets the host and each registrable parent', () => {
    assert.deepEqual(cookieDomainsFor('transmogrify.sh'), [undefined, '.transmogrify.sh']);
    assert.deepEqual(cookieDomainsFor('www.transmogrify.sh'), [
      undefined,
      '.www.transmogrify.sh',
      '.transmogrify.sh',
    ]);
  });

  test('does not attempt a domain attribute for localhost or a bare IP', () => {
    assert.deepEqual(cookieDomainsFor('localhost'), [undefined]);
    assert.deepEqual(cookieDomainsFor('127.0.0.1'), [undefined]);
    assert.deepEqual(cookieDomainsFor(''), [undefined]);
  });
});
