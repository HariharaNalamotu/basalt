// Design guidelines for apps agents build on Basalt Host. Written by Codex (design lead) from a
// critique of a real agent-built salon app; Claude follows them. Lives behind host_guide { topic: "design" }.
export const design = `# Small Business Web App Design Guidelines

**On Basalt Host:** run the pre-ship check (section 9) on the preview with the browser tools: \`browser_open { app, env, viewport: "phone", colorScheme: "dark" }\` (and again with \`viewport: "desktop"\`, \`colorScheme: "light"\`), sign in with \`host_test_user\`, then \`browser_screenshot\` each page and look at it. Pages may only load files from the app itself, so put the CSS starter below in a local stylesheet, use system fonts and draw icons as inline SVG.

## 1. Principles

1. **Identify the business before requesting an account.** Public pages show the business name, offering, location or service area, hours, and one primary action. Require authentication when a customer needs to save or manage something.
2. **Make one next action obvious.** Each page or task section has one primary button. Secondary actions use outlined buttons or text links.
3. **Show the decision before collecting details.** Display service descriptions, prices, durations, availability, and relevant policies before confirmation. Never invent missing business facts.
4. **Design every save outcome.** Pending, successful, invalid, unavailable, and failed states receive deliberate layouts, useful language, and a clear next action.
5. **Ship a business identity, not a component showcase.** Repeat a restrained palette, distinctive heading treatment, consistent spacing, and business-specific copy across public, authentication, and account pages.

## 2. Brand from the business

Derive personality from the service and name. Pick two attributes, such as "warm + polished." Express them through typography, color, corner radius, and copy. Avoid literal decoration on every surface.

Use one brand color, neutral surfaces, and separate semantic colors. Brand color belongs on primary actions, selected controls, links, and small identity details. Keep most surfaces neutral.

The following are complete brand overrides for the starter. Columns map to \`--bg\`, \`--surface\`, \`--ink\`, \`--muted\`, \`--brand\`, \`--brand-hover\`, \`--on-brand\`, and \`--soft\`.

| Business and personality | Theme | Background | Surface | Ink | Muted | Brand | Hover | On brand | Soft |
|---|---|---|---|---|---|---|---|---|---|
| Shear Joy salon: warm, polished | Light | \`#FBF7F8\` | \`#FFFFFF\` | \`#292126\` | \`#6C5964\` | \`#92345F\` | \`#78284D\` | \`#FFFFFF\` | \`#F6E7EE\` |
| Shear Joy salon | Dark | \`#191418\` | \`#241D22\` | \`#FAF3F7\` | \`#C7B5C0\` | \`#F0A6C7\` | \`#F6BED7\` | \`#321423\` | \`#382530\` |
| Ember & Grain cafe: earthy, lively | Light | \`#FAF7F0\` | \`#FFFFFF\` | \`#29251F\` | \`#685E51\` | \`#824021\` | \`#693219\` | \`#FFFFFF\` | \`#F3E6D7\` |
| Ember & Grain cafe | Dark | \`#191713\` | \`#25211B\` | \`#FAF4E9\` | \`#C7BBAA\` | \`#EEB183\` | \`#F5C49E\` | \`#302015\` | \`#392A20\` |
| Northline Physio: calm, precise | Light | \`#F4F8F8\` | \`#FFFFFF\` | \`#182F35\` | \`#50676D\` | \`#176575\` | \`#104F5C\` | \`#FFFFFF\` | \`#E0F0F2\` |
| Northline Physio | Dark | \`#111C20\` | \`#1B2A30\` | \`#EDF7F8\` | \`#ADC3C8\` | \`#82CDDA\` | \`#A0DEE7\` | \`#102D34\` | \`#213B43\` |

- **Salon:** sans-serif headings, 700 weight, 12px cards, restrained rose highlights. Example heading: "Make time for your next look."
- **Cafe:** serif headings, 700 weight, 8px cards, warm neutral sections. Example heading: "Your morning, freshly made."
- **Physio:** sans-serif headings, 700 weight, 8px cards, clearly numbered booking steps. Example heading: "Book your next appointment."
- Use the shared type scale below. Personality changes the heading family and wording, not basic readability.
- Use owner-provided assets stored locally. Without assets, use a typographic wordmark and a simple inline SVG motif. Never invent staff portraits, reviews, certifications, or photographs of the premises.

## 3. Layout and spacing

- Spacing scale: **4, 8, 12, 16, 24, 32, 48, 64, 96px**. Use 8px within related controls, 16px between fields, 24px between groups, and 48px between mobile sections.
- Page container: \`1120px\` maximum. Side gutters: 16px below 768px, 24px above it. Reading text: \`65ch\` maximum.
- Use one column on phones. At 768px, use a 12-column grid with 24px gaps. Booking details span eight columns; the summary spans four. Account content has a \`960px\` maximum.
- Header: minimum 64px tall; wordmark left, principal navigation right. At phone widths, retain the primary action and put secondary navigation behind a labeled menu button.
- Footer: business name, verified contact details, hours/location when supplied, and privacy/account links. Stack on phones. Do not invent contact information.
- Public hero: 32px vertical padding on phones, 64px on desktop. Include a specific heading, one supporting sentence, primary CTA, and verified practical details. Use a two-column desktop hero only when useful local imagery exists.
- Booking sequence: **service → date and time → customer details → review and confirm**. Show progress only when these are genuinely separate steps.
- Service choices show name, price, and duration when known. Date navigation sits above visible time chips, grouped by morning/afternoon when helpful.
- Keep the selected service, date, time, and price visible in a summary. On phones, place it before confirmation; desktop may use a sticky sidebar.
- After booking, replace the active form with confirmation and appointment details. Provide "View my bookings" and "Book another appointment."
- Account pages lead with the next booking. Separate upcoming and past bookings. Keep cancellation controls secondary and explain any applicable policy before confirmation.

## 4. Typography

- Sans: \`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif\`.
- Serif: \`ui-serif, Georgia, Cambria, "Times New Roman", serif\`. Use for selected brand headings only.
- Body and controls: **16px / 1.5 / 400**. Supporting text: **14px / 1.5 / 400**. Labels: **14px / 1.5 / 600**.
- Page title: **32px / 1.15 / 700** on phones, **40px** on desktop. Hero title: **36px** on phones, **56px** on desktop.
- Section title: **24px / 1.25 / 700**. Card title: **18px / 1.35 / 650**. Buttons: **16px / 1.25 / 650**.
- Use sentence case. Keep headings within \`20ch\`; avoid uppercase paragraphs, excessively tight tracking, and essential text below 14px.
- Use tabular numerals for times, prices, and verification codes. Avoid fixed heights on text containers.

## 5. Components

Copy the exact component CSS in section 8. Extend it with business-specific content, not inconsistent one-off styles.

| Component | Required construction and behavior |
|---|---|
| Buttons | \`.btn\` primary, \`.btn.secondary\` alternate, \`.btn.danger\` destructive. Minimum 44px height. Use real buttons for actions and anchors for navigation. Pending label describes work, such as "Booking…" |
| Inputs | \`.field\` contains a persistent \`<label>\`, input, optional hint, and error. Use \`.control\`; connect descriptions through \`aria-describedby\`. Mark invalid fields with \`aria-invalid="true"\`. |
| Selects | Native \`<select class="control">\` for compact categorical choices. Keep platform affordances. Use service cards when price and duration need comparison. |
| Dates | Labeled native \`<input type="date" class="control">\` by default. Explain unavailable dates. A custom calendar requires keyboard navigation, accessible names, and complete selection behavior. |
| Time chips | \`.slots\` contains \`.slot\` buttons with \`aria-pressed\`. Use explicit labels such as "10:00 AM." Disable unavailable slots and distinguish them visually. |
| Cards | \`.card\` groups a decision, summary, or appointment. Avoid wrapping every paragraph in its own card. Use borders as the main separation; reserve shadow for raised surfaces. |
| Booking lists | Semantic \`<ul class="booking-list">\`; each \`.booking\` shows service, full date, time, location/provider when relevant, status, and management action. |
| Badges | \`.badge\`, optionally \`.success\` or \`.error\`. Always include a word such as "Confirmed" or "Cancelled"; color alone is insufficient. |
| Messages | \`.message\` with \`.success\` or \`.error\`. Include a clear outcome and next step. Use \`role="status"\` for updates and \`role="alert"\` for newly triggered blocking errors. |
| Toasts | \`.toast\` is optional for nonessential acknowledgments. Never put the only booking confirmation or actionable failure in a disappearing toast. |
| Empty states | \`.empty\` contains a specific heading, explanation, and useful action: "No upcoming appointments" plus "Book an appointment." Avoid decorative illustrations that overwhelm the task. |
| Skeletons | \`.skeleton\` matches the eventual content geometry and is \`aria-hidden="true"\`. Put \`aria-busy="true"\` and an accessible loading status on the containing region. |
| Success | Show service, date including year, time, and confirmation reference when supplied. Claim an email was sent only when confirmed. |
| Failure | Preserve entered values. For a taken slot, refresh availability, clear its selection, and keep the error beside the time choices. For network failure, retain the selection and offer retry. |

## 6. Forms and copy

- Ask only for necessary information. Mark optional fields explicitly. Use \`autocomplete\`, appropriate \`type\`, and \`inputmode\`; allow password managers and pasting.
- Validate on blur or submit, not on every keystroke. On failed submission, focus an error summary linking to invalid fields; keep individual errors beside their controls.
- Sign-in uses the same brand header and surfaces as the public site. Include "Create an account" and "Forgot password?" only when those routes work.
- Sign-up: email and password → send code → one six-digit code field → account confirmation. Use \`type="text"\`, \`inputmode="numeric"\`, \`autocomplete="one-time-code"\`, and \`maxlength="6"\` so leading zeros survive.
- Show "Enter the 6-digit code sent to {email}." Offer "Change email" and resend with the actual enforced cooldown. Do not invent expiry times.
- Booking labels: "Choose a service," "Choose a date," "Available times," "Phone number." Explain why a phone number is required.
- Review CTA: "Confirm appointment" or "Pay {amount} and book" according to actual behavior. Ordering CTAs disclose the total before submission.
- Success: "Your appointment is confirmed" followed by "Colour · Friday, 6 November 2026 · 10:00 AM."
- Conflict: "That time has just been booked. Choose another available time below."
- Save failure: "We couldn't save your booking. Your details are still here. Please try again." For uncertain outcomes, check saved bookings before enabling another submission.
- Code error: "That code didn't match. Check the email and try again." Sign-in error: "Email or password is incorrect."
- Keep server messages as text, never injected HTML. Map known errors to useful copy; show unknown plain messages inside the error component without exposing technical internals.

## 7. Mobile and accessibility checklist

- Test at **360px, 390px, and 430px**. No horizontal scrolling, clipped controls, overlapping buttons, or fixed elements covering content.
- Minimum touch target: **44 × 44px**, preferably 48px for primary actions. Keep at least 8px between adjacent targets.
- Text contrast: **4.5:1** minimum; large text **3:1**. Essential control boundaries, selected states, and focus indicators: **3:1** against adjacent colors. Recheck every palette override.
- Use a visible **3px focus ring with 3px offset**. Verify all actions by keyboard, logical tab order, and focus restoration after dialogs.
- Use landmarks, one page \`<h1>\`, ordered heading levels, real labels, and descriptive accessible names. Hide decorative SVGs from assistive technology.
- Support 200% text zoom and reflow at 320 CSS pixels. Let long names, emails, translated copy, and messages wrap.
- Respect \`prefers-reduced-motion\`. Never require animation, hover, dragging, or color perception to complete a task.
- Respect \`prefers-color-scheme\` on first render. Test native controls and every interactive state in both themes.
- Keep CSS, JavaScript, fonts, and images on the app's origin. Reference local stylesheet/script files; use inline SVG markup without external dependencies. Do not assume inline scripts or style attributes are permitted by CSP.

## 8. Complete CSS starter

Copy into a local \`styles.css\`. Default palette: Shear Joy. Replace the eight brand tokens with the chosen example in both theme blocks. The file below is under 120 lines.

\`\`\`css
:root {
  color-scheme:light;
  --bg:#FBF7F8;--surface:#FFFFFF;--ink:#292126;--muted:#6C5964;
  --brand:#92345F;--brand-hover:#78284D;--on-brand:#FFFFFF;--soft:#F6E7EE;
  --line:#897681;--focus:#175DA8;--success:#17613B;--success-bg:#EAF6EE;
  --error:#A32232;--error-bg:#FFF0F1;--disabled:#E9E1E5;--skeleton:#E9E1E5;
  --sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --serif:ui-serif,Georgia,Cambria,"Times New Roman",serif;--heading:var(--sans);
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s6:24px;
  --s8:32px;--s12:48px;--s16:64px;--s24:96px;
  --radius:12px;--shadow:0 4px 16px #2915240A;
}
@media(prefers-color-scheme:dark) {
  :root {
    color-scheme:dark;
    --bg:#191418;--surface:#241D22;--ink:#FAF3F7;--muted:#C7B5C0;
    --brand:#F0A6C7;--brand-hover:#F6BED7;--on-brand:#321423;--soft:#382530;
    --line:#947D8A;--focus:#9DCBFF;--success:#9DE0B5;--success-bg:#183626;
    --error:#FFB3BD;--error-bg:#421E28;--disabled:#382E35;--skeleton:#382E35;
    --shadow:0 4px 16px #00000026;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.5 var(--sans)}
button,input,select,textarea{font:inherit}
button,a,input,select,textarea{-webkit-tap-highlight-color:transparent}
a{color:var(--brand);text-underline-offset:3px}
a:hover{color:var(--brand-hover)}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
h1,h2,h3,p{margin:0}
h1,h2,h3{font-family:var(--heading);overflow-wrap:anywhere}
h1{font-size:32px;line-height:1.15;font-weight:700;max-width:20ch}
h2{font-size:24px;line-height:1.25;font-weight:700}
h3{font-size:18px;line-height:1.35;font-weight:650}
p{max-width:65ch;overflow-wrap:anywhere}
small,.hint,.muted{font-size:14px;line-height:1.5;color:var(--muted)}
.container{width:min(100% - 32px,1120px);margin-inline:auto}
.account{max-width:960px}.auth{max-width:440px;margin:32px auto}
.stack{display:grid;gap:16px}.section{padding-block:48px}
.site-header{border-bottom:1px solid var(--line);background:var(--surface)}
.header-inner{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-block:12px}
.wordmark{font-size:22px;font-weight:750;text-decoration:none}
.site-footer{margin-top:48px;padding-block:32px;border-top:1px solid var(--line);color:var(--muted)}
.hero{display:grid;gap:24px;padding-block:32px}.hero h1{font-size:36px}
.hero img{display:block;width:100%;height:auto;border-radius:var(--radius)}
.booking-layout{display:grid;gap:24px;align-items:start}
.card{min-width:0;padding:24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.card.raised{box-shadow:var(--shadow)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:12px 20px;border:1px solid transparent;border-radius:8px;background:var(--brand);color:var(--on-brand);font-size:16px;font-weight:650;line-height:1.25;text-decoration:none;cursor:pointer;text-align:center}
.btn:hover{background:var(--brand-hover);color:var(--on-brand)}
.btn.secondary{background:var(--surface);border-color:var(--line);color:var(--ink)}
.btn.secondary:hover{background:var(--soft)}
.btn.danger{background:var(--error-bg);border-color:var(--error);color:var(--error)}
.btn:disabled,.btn[aria-disabled="true"]{background:var(--disabled);color:var(--muted);border-color:var(--line);cursor:not-allowed}
.field{display:grid;gap:8px;min-width:0}
label,legend{font-size:14px;font-weight:600}
fieldset{margin:0;padding:0;border:0;min-width:0}
legend{margin-bottom:8px}
.control{width:100%;min-width:0;min-height:48px;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.control::placeholder{color:var(--muted);opacity:1}
textarea.control{min-height:120px;resize:vertical}
.control[aria-invalid="true"]{border:2px solid var(--error)}
.control:disabled{background:var(--disabled);color:var(--muted)}
.field-error{font-size:14px;color:var(--error)}
.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}
.slot{min-height:48px;padding:10px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:600 16px/1.5 var(--sans);font-variant-numeric:tabular-nums;cursor:pointer}
.slot:hover:not(:disabled){background:var(--soft)}
.slot[aria-pressed="true"]{background:var(--brand);color:var(--on-brand);border-color:var(--brand);box-shadow:inset 0 0 0 2px var(--on-brand)}
.slot:disabled{background:var(--disabled);color:var(--muted);text-decoration:line-through;cursor:not-allowed}
.booking-list{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.booking{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px;border:1px solid var(--line);border-radius:8px}
.booking>*{min-width:0;overflow-wrap:anywhere}
.badge{display:inline-flex;padding:4px 8px;border-radius:6px;background:var(--soft);color:var(--ink);font-size:14px;font-weight:600}
.message{padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--soft);overflow-wrap:anywhere}
.message.success,.badge.success{background:var(--success-bg);color:var(--success);border-color:var(--success)}
.message.error,.badge.error{background:var(--error-bg);color:var(--error);border-color:var(--error)}
.toast{position:fixed;inset:auto 16px 24px;max-width:440px;margin-inline:auto;z-index:20;box-shadow:var(--shadow)}
.empty{display:grid;justify-items:start;gap:12px;padding:32px 24px;border:1px dashed var(--line);border-radius:var(--radius)}
.skeleton{min-height:16px;border-radius:6px;background:var(--skeleton)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(min-width:768px){
  .container{width:min(100% - 48px,1120px)}
  h1{font-size:40px}.hero{padding-block:64px}.hero h1{font-size:56px}
  .hero.with-image{grid-template-columns:1.1fr 1fr;align-items:center;gap:48px}
  .booking-layout{grid-template-columns:repeat(12,minmax(0,1fr))}
  .booking-main{grid-column:span 8}.booking-summary{grid-column:span 4;position:sticky;top:24px}
  .section{padding-block:64px}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
\`\`\`

## 9. Pre-ship visual checklist

Before telling the owner the app is done, run the app and inspect actual browser screenshots. Do not substitute code review for rendered inspection.

- Capture the public landing, sign-in, sign-up/code entry, main transaction, and account pages at **1440px desktop and 390px phone**, in **both light and dark mode**.
- Capture booking/order success, validation errors, unavailable selection, save failure, empty account, and loading states at 390px. Use clearly identified development fixtures when real failures are hard to reproduce.
- Check 360px and 430px widths, long business names, long emails, and 200% text zoom. Confirm that the on-screen keyboard does not hide the focused field or next action.
- Inspect visual hierarchy: recognizable business identity, one primary action per task, readable supporting text, consistent spacing, and no accidental empty expanses.
- Verify keyboard operation, focus visibility, label associations, live announcements, measured contrast, and reduced-motion behavior.
- Check the network and console for CSP violations, missing local assets, external requests, and runtime errors. Test under the production CSP.
- Submit a real test transaction, refresh, and verify persistence and account visibility. Test conflict recovery and failed-save recovery without duplicate submissions.
- Fix every observed defect, recapture affected screens, and report any unavailable verification explicitly. Only then describe the app as ready.
`;
