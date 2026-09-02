/**
 * Analytics consent policy.
 *
 * The rules, in order of precedence:
 *
 *  1. No measurement ID configured → analytics does not exist on this build.
 *     Nothing is loaded, no prompt is shown, and the privacy control says so.
 *  2. Global Privacy Control or Do Not Track → analytics stays off everywhere,
 *     no prompt is shown, and the state is explained rather than hidden. A
 *     browser-level opt-out is not something to ask the visitor to override.
 *  3. A stored choice → honoured.
 *  4. Otherwise → nothing loads and the visitor is asked.
 *
 * Consent is required worldwide. Client-side geography is unreliable and the
 * conservative behaviour is also the simpler one: no request reaches Google
 * before an affirmative click, anywhere.
 *
 * This module is pure so it can be unit tested without a DOM.
 */

export type StoredConsent = 'granted' | 'denied' | null;

export type ConsentState =
  /** No measurement ID is configured for this build. */
  | 'unavailable'
  /** A browser privacy signal is switched on. */
  | 'signal'
  /** The visitor has allowed analytics. */
  | 'granted'
  /** The visitor has declined analytics. */
  | 'denied'
  /** The visitor has not been asked yet, or has reopened the choice. */
  | 'unset';

export interface BrowserSignals {
  /** `navigator.globalPrivacyControl === true` */
  gpc: boolean;
  /** `navigator.doNotTrack === '1'` (or the legacy window/msDoNotTrack forms) */
  dnt: boolean;
}

export interface ConsentDecision {
  state: ConsentState;
  /** Whether Google Analytics may be loaded and may send events. */
  analyticsEnabled: boolean;
  /** Whether the consent prompt should be presented. */
  showPrompt: boolean;
  /** Label for the persistent footer control. */
  controlLabel: string;
  /** Sentence announced to assistive technology and shown in the prompt UI. */
  statusText: string;
}

export const STORAGE_KEY = 'transmogrify:analytics-consent';

export function decideConsent(input: {
  measurementId: string | undefined | null;
  stored: StoredConsent;
  signals: BrowserSignals;
  /** True when the visitor explicitly reopened the choice. */
  reopened?: boolean;
}): ConsentDecision {
  const measurementId = input.measurementId?.trim();

  if (!measurementId) {
    return {
      state: 'unavailable',
      analyticsEnabled: false,
      showPrompt: false,
      controlLabel: 'Privacy choices',
      statusText: 'This site is not configured with analytics. Nothing is measured.',
    };
  }

  if (input.signals.gpc || input.signals.dnt) {
    const which = input.signals.gpc ? 'Global Privacy Control' : 'Do Not Track';
    return {
      state: 'signal',
      analyticsEnabled: false,
      showPrompt: false,
      controlLabel: 'Privacy choices',
      statusText: `Analytics is off because your browser sends a ${which} signal. That signal is honoured and you will not be asked again.`,
    };
  }

  if (input.stored === 'granted' && !input.reopened) {
    return {
      state: 'granted',
      analyticsEnabled: true,
      showPrompt: false,
      controlLabel: 'Privacy choices: analytics on',
      statusText: 'Analytics is on. You can turn it off at any time.',
    };
  }

  if (input.stored === 'denied' && !input.reopened) {
    return {
      state: 'denied',
      analyticsEnabled: false,
      showPrompt: false,
      controlLabel: 'Privacy choices: analytics off',
      statusText: 'Analytics is off. Nothing is sent to Google.',
    };
  }

  return {
    state: 'unset',
    analyticsEnabled: false,
    showPrompt: true,
    controlLabel:
      input.stored === 'granted'
        ? 'Privacy choices: analytics on'
        : input.stored === 'denied'
          ? 'Privacy choices: analytics off'
          : 'Privacy choices',
    statusText: 'Analytics is off until you allow it.',
  };
}

/**
 * Cookie names Google Analytics 4 sets from the browser for a given
 * measurement ID. Used to clear what we can when consent is withdrawn.
 */
export function analyticsCookieNames(measurementId: string): string[] {
  const streamSuffix = measurementId.replace(/^G-/, '');
  return ['_ga', `_ga_${streamSuffix}`, '_gid', `_gat_gtag_${measurementId.replace(/-/g, '_')}`];
}

/**
 * Every host a cookie may have been scoped to: the exact hostname and each
 * registrable parent, so `.example.com` cookies set by the GA snippet are also
 * targeted. Deliberately stops before a bare public suffix.
 */
export function cookieDomainsFor(hostname: string): (string | undefined)[] {
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname === 'localhost') {
    return [undefined];
  }
  const parts = hostname.split('.');
  const domains: (string | undefined)[] = [undefined];
  for (let index = 0; index <= parts.length - 2; index += 1) {
    domains.push('.' + parts.slice(index).join('.'));
  }
  return domains;
}
