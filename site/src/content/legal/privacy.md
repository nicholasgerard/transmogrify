---
title: Privacy Policy
description: >-
  What transmogrify.sh does and does not collect. By default the site sets no
  cookies, runs no analytics, and makes no third-party request. Analytics, if
  ever enabled, is opt-in.
effectiveDate: '2026-09-02'
order: 2
summary: >-
  This is a static documentation site. It has no accounts, no forms, no
  database, and no server-side code. Browsing it sends no information to the
  project. If you email support, the project receives what you choose to send.
  Analytics, if ever enabled, remains opt-in.
---

## 1. Scope

This policy covers **transmogrify.sh**, a static website that documents the
Transmogrify open-source project.

It does not cover the Transmogrify software you install and run. That software
runs entirely on your own machine, talks only to the coding-agent providers you
configure, and sends nothing to this website or to the project. It works with
no network access to this domain at all.

It also does not cover other people's services. When you follow a link to
GitHub, OpenAI, Anthropic, or anywhere else, that site's own privacy policy
applies.

If you email [support@thebkapp.co](mailto:support@thebkapp.co), the project
receives your email address, message, and anything you attach. That information
is used to answer and administer the matter you raised, preserve security,
prevent abuse, and meet legal obligations. It is not sold or used for marketing.
Send the minimum information needed, and never send provider credentials,
private transcripts, or session identifiers in ordinary email. You may ask for
the correspondence to be deleted when the matter is closed, subject to records
that must be kept for security, abuse prevention, or legal obligations.

## 2. What this site is, technically

Every page here is a pre-built HTML file. There is no application server, no
database, no API, no login, no form, no comment system, no newsletter, and no
payment. Nothing you do on this site is transmitted to the project, because
there is nowhere for it to be transmitted to.

The site also uses no web fonts, no embedded videos, no tracking pixels, no
social widgets, no advertising, no fingerprinting, and no cross-site tracking
of any kind. Every asset it loads comes from this domain.

## 3. Hosting and server logs

The site is served by **Cloudflare Workers Static Assets**. As with any website, Cloudflare
processes the technical information required to deliver a page to you — your IP
address, the requested URL, the time of the request, your user agent, and
similar connection metadata — and it uses that information to route traffic,
serve content, and protect the site against abuse.

That processing happens at the hosting layer and is Cloudflare's, not this
project's. The project does not receive, request, store, or analyse those logs,
and does not use Cloudflare Web Analytics. For details on what Cloudflare
collects as a hosting provider, see the
[Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/).

## 4. What is stored in your browser

The site can store two things locally. Both live only in your own browser, both
are ordinary `localStorage` entries rather than cookies, and neither is ever
sent anywhere.

| Key | Purpose | Set when |
| --- | --- | --- |
| `transmogrify:theme` | Remembers whether you chose light, dark, or "match system". | You pick a theme. |
| `transmogrify:analytics-consent` | Remembers your analytics answer so you are not asked again. | You answer the analytics question. |

Clearing your browser's site data for this domain removes both. Doing so resets
the theme to your system preference and means you will be asked about analytics
again.

<span id="analytics"></span>

## 5. Analytics

**The default is no analytics at all.** When this site is built without a
Google Analytics measurement ID — which is the default configuration — no
analytics code exists in the page, no consent question is shown, and there is
nothing to opt in or out of.

Analytics is disabled for the initial public release. The dormant opt-in build
path will not be enabled in production until this policy names a private
controller contact, the configured retention period, and the applicable
processor and international-transfer terms. If a later release enables a
measurement ID, the site behavior is:

- **Nothing loads before you say yes.** No Google script, no preconnect, no DNS
  prefetch, no request of any kind is made to Google or to
  `googletagmanager.com` until you press **Allow analytics**. Consent is
  required worldwide — not only in regions where the law demands it, and not
  based on guessing where you are.
- **Declining costs you nothing.** Every page, link, control, and copy button
  works identically whether you allow analytics, decline it, or never answer.
- **Your answer is remembered locally** in the `transmogrify:analytics-consent`
  entry described above.
- **You can change your mind at any time** with the **Privacy choices** control
  in the footer of every page. It also states your current setting.
- **Withdrawing consent stops future measurement** on the spot: analytics is
  disabled for the rest of the page view, no further events are sent, and the
  first-party analytics cookies the browser set (`_ga`, `_ga_…`, `_gid`, and
  the `_gat` throttle cookie) are expired. Data that Google already received
  before you withdrew is held by Google under its own policies; this site
  cannot delete it. To ask Google directly, see
  [Google's Privacy Policy](https://policies.google.com/privacy) and
  [how Google uses data from sites that use its services](https://policies.google.com/technologies/partner-sites).
- **If analytics is on**, Google Analytics 4 records ordinary web measurement:
  pages viewed, referrer, approximate location derived from IP, device and
  browser type, and a randomly generated identifier stored in those cookies. It
  is configured with IP anonymisation on, and with Google's advertising storage,
  ad personalisation, and ad user data signals explicitly denied. It is used to
  understand which documentation people actually read. It is never used for
  advertising, and no data is sold or shared for advertising.

### Global Privacy Control and Do Not Track

If your browser sends a **Global Privacy Control** or **Do Not Track** signal,
analytics stays off and you are not asked at all. The footer control will tell
you that the signal is being honoured. This site treats those signals as a
decision, not as a suggestion to argue with.

## 6. What this site never does

- It does not collect your name, email address, or any other personal detail —
  there is no field in which to enter one.
- It does not sell or share personal information, and it does not engage in
  "sharing" for cross-context behavioural advertising as those terms are used
  in United States state privacy laws.
- It does not build a profile of you, target advertising, or attempt to
  identify you across sites.
- It does not knowingly collect information from children. There is nothing on
  this site that collects information from anyone.

## 7. Your rights

Because browsing this site gives the project no personal information, there is
generally nothing from a site visit for it to access, correct, export, or delete
on request.
The two things it can store are in your browser and under your control: clear
your site data to remove them, and use **Privacy choices** to change your
analytics setting.

If analytics is enabled and you have allowed it, the data collected is held by
Google as described in Google's own policies, and Google's controls apply. You
can also install
[Google's browser opt-out add-on](https://tools.google.com/dlpage/gaoptout) to
block Google Analytics on every site.

Depending on where you live, you may have rights under laws such as the GDPR,
the UK GDPR, or United States state privacy laws. Where analytics is enabled,
the lawful basis for it is your consent, and you may withdraw that consent at
any time without giving a reason and without any effect on the site. To raise a
privacy question or exercise a privacy right, email
[support@thebkapp.co](mailto:support@thebkapp.co). Do not open a public issue
containing personal information.

## 8. Security

The site is static, served over HTTPS with HSTS, and sends a restrictive
Content Security Policy along with `X-Content-Type-Options`, a deny-all frame
policy, a strict referrer policy, and a Permissions-Policy that switches off
sensitive browser features. The website itself has no server-side application
or personal-data store. Support correspondence remains subject to the ordinary
security and retention risks of the email provider that carries it; send only
the information needed to resolve the matter.

Security defects in the Transmogrify project should be reported through its
[private vulnerability reporting form](https://github.com/nicholasgerard/transmogrify/security/advisories/new),
never in a public issue. The project's full
[Security policy](https://github.com/nicholasgerard/transmogrify/blob/main/SECURITY.md)
describes the trust boundaries of the software itself.

## 9. Changes to this policy

The effective date at the top of this page changes whenever this policy does,
and every revision is visible in the project's public Git history. If the site
ever begins collecting something it does not collect today, this page will say
so before that change ships.
