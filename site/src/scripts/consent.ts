/**
 * Analytics consent runtime.
 *
 * The load-bearing guarantee: no script tag, preconnect, DNS prefetch, or
 * request of any kind reaches Google before `grant()` runs, and `grant()` runs
 * only from an affirmative click or a previously stored affirmative choice.
 *
 * The policy itself lives in `src/lib/consent.ts` and is unit tested. This file
 * is only the DOM wiring.
 */
import {
  STORAGE_KEY,
  analyticsCookieNames,
  cookieDomainsFor,
  decideConsent,
  type ConsentDecision,
  type StoredConsent,
} from '../lib/consent.ts';

const measurementId = document.body.dataset.analyticsId?.trim() ?? '';

const control = document.querySelector<HTMLAnchorElement>('[data-privacy-choices]');
const stateOut = document.querySelector<HTMLElement>('[data-privacy-state]');
const dialog = document.getElementById('consent-dialog');

type GtagWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
} & Record<string, unknown>;

const w = window as unknown as GtagWindow;
const disableFlag = `ga-disable-${measurementId}`;

/** Set before anything else so a late-arriving gtag cannot send on load. */
if (measurementId) w[disableFlag] = true;

function readStored(): StoredConsent {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredConsent): void {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Without storage the choice applies to this page view only, which is the
    // safe direction: the visitor is asked again rather than assumed.
  }
}

function readSignals() {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const legacy = (window as Window & { doNotTrack?: string }).doNotTrack;
  return {
    gpc: nav.globalPrivacyControl === true,
    dnt: nav.doNotTrack === '1' || legacy === '1' || nav.msDoNotTrack === '1',
  };
}

let scriptAppended = false;
let hideTimer: number | undefined;

function loadAnalytics(): void {
  if (!measurementId) return;
  w[disableFlag] = false;

  w.dataLayer = w.dataLayer || [];
  const gtag =
    w.gtag ??
    ((...args: unknown[]) => {
      w.dataLayer?.push(args);
    });
  w.gtag = gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });
  gtag('js', new Date());
  gtag('config', measurementId, { anonymize_ip: true });

  if (scriptAppended) return;
  scriptAppended = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

function stopAnalytics(): void {
  if (!measurementId) return;
  w[disableFlag] = true;
  w.gtag?.('consent', 'update', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  clearAnalyticsCookies();
}

/**
 * Best effort: browser-set analytics cookies are first-party and same-site, so
 * they can be expired from here. Anything HttpOnly or set elsewhere cannot be,
 * and the privacy page says so rather than overclaiming.
 */
function clearAnalyticsCookies(): void {
  const names = analyticsCookieNames(measurementId);
  const domains = cookieDomainsFor(location.hostname);
  const paths = ['/', location.pathname];
  for (const name of names) {
    for (const domain of domains) {
      for (const path of paths) {
        document.cookie =
          `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}` +
          (domain ? `; domain=${domain}` : '') +
          (location.protocol === 'https:' ? '; secure; samesite=lax' : '');
      }
    }
  }
}

function showDialog(focus: boolean): void {
  if (!dialog) return;
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  dialog.hidden = false;
  // Commit the hidden→visible change before starting the transition.
  void dialog.offsetHeight;
  dialog.dataset.open = 'true';
  if (focus) dialog.focus();
}

function hideDialog(): void {
  if (!dialog) return;
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  hideTimer = undefined;
  delete dialog.dataset.open;
  const finish = () => {
    dialog.hidden = true;
    hideTimer = undefined;
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) finish();
  else hideTimer = window.setTimeout(finish, 240);
}

function render(decision: ConsentDecision, focusDialog = false): void {
  if (control) control.textContent = decision.controlLabel;
  if (stateOut) stateOut.textContent = decision.statusText;

  if (decision.analyticsEnabled) loadAnalytics();
  else stopAnalytics();

  if (decision.showPrompt) showDialog(focusDialog);
  else hideDialog();
}

function evaluate(options: { reopened?: boolean; focusDialog?: boolean } = {}): ConsentDecision {
  const decision = decideConsent({
    measurementId,
    stored: readStored(),
    signals: readSignals(),
    ...(options.reopened !== undefined ? { reopened: options.reopened } : {}),
  });
  render(decision, options.focusDialog ?? false);
  return decision;
}

dialog?.querySelector('[data-consent="allow"]')?.addEventListener('click', () => {
  writeStored('granted');
  evaluate();
  control?.focus();
});

dialog?.querySelector('[data-consent="deny"]')?.addEventListener('click', () => {
  writeStored('denied');
  evaluate();
  control?.focus();
});

control?.addEventListener('click', (event) => {
  const decision = evaluate({ reopened: true, focusDialog: true });
  // Under GPC or DNT the consent decision cannot be changed. Preserve the
  // anchor's normal /privacy#analytics navigation instead of trapping the
  // visitor on an inert enhanced control.
  if (decision.showPrompt) event.preventDefault();
});

evaluate();

// The first render states the current situation rather than reporting a change,
// so it is written into a silent region; every later render is announced.
stateOut?.setAttribute('aria-live', 'polite');
