# Basalt design system

Version 1.0. This specification governs the owner dashboard, approvals, data map, Guard receipts, Connect Claude, and stage demo.

Written by Codex (design lead); Claude implements it. The stylesheet is `design/basalt.css`. Two decisions differ from Codex's first draft and are written in below: owner pages follow the device's light or dark setting instead of a toggle, and the stage panel shows every result on one screen instead of paging.

The visual character is **black, silver, precise, and quiet**. Create the impression of well-made hardware through alignment, clear edges, restrained highlights, and readable controls. Avoid decorative security imagery.

## 1. Principles

1. **Make the consequence understandable.** Say who can do what, to whose information, in which app. Technical details follow the plain-language explanation.
2. **Earn every safety claim.** Show what was checked, when, and against which version. Unknown, unavailable, and failed checks must remain visible.
3. **Make consent deliberate.** Approval is a decision, never a celebratory onboarding step. Keep the question, consequence, and both answers together.
4. **Use silver for identity; color for evidence.** Most of the interface is neutral. Status colors occupy small, purposeful areas and always accompany words and icons.
5. **Design for imperfect viewing.** Small laptops, older eyes, browser zoom, and washed-out projectors are normal conditions. Essential information never depends on faint text, hover, or animation.

## Logo

One basalt column: basalt rock cools into tight hexagonal columns, which is the idea behind the product (fixed, solid blocks underneath every app). Claude drew three concepts; Codex picked this one and set the geometry; the dark-theme body color was then darkened so the lit facets still read at 16px.

- Files: `design/logo/basalt-mark-dark.svg` (for dark backgrounds) and `design/logo/basalt-mark-light.svg` (for light backgrounds). viewBox `0 0 64 64`, three polygons, no strokes or gradients.
- Colors: dark backgrounds use body `#7D8996` and facets `#E3E6EA` (tokens `--logo-body`, `--logo-facet`); light backgrounds use body `#15181C` and facets `#C6CCD3`.
- Wordmark: "Basalt" in the system sans stack, weight 600, letter spacing −0.02em, text height about 0.75 of the mark, 12px gap after the mark.
- At favicon sizes use the mark alone. Don't recolor it with status colors, add a metal gradient or put it in a container shape.

## 2. Color system

Dark is the default. The dashboard offers a persistent, explicitly labeled theme control and remembers the owner’s selection. Single-purpose owner pages (approval, receipt, data map) have no control: they follow the device's light or dark setting, defaulting to dark. `data-theme` on the root overrides both. Both themes have identical hierarchy and behavior.

### Neutral tokens

These are opaque colors. Do not lower their opacity.

| CSS custom property | Dark | Light | Role |
|---|---|---|---|
| `--bg-0` | `#0C0E11` | `#F3F5F7` | Page canvas |
| `--bg-1` | `#13161A` | `#FFFFFF` | Sidebar, cards, fields |
| `--bg-2` | `#1B1F24` | `#EAEEF2` | Hovered rows, inset regions |
| `--bg-3` | `#242A31` | `#DEE4EA` | Selected navigation, pressed controls, disabled controls |
| `--border` | `#353D47` | `#CAD1D9` | Decorative card edges and separators |
| `--edge` | `#7D8996` | `#697684` | Input and outlined-control boundaries |
| `--text` | `#F2F4F6` | `#171B20` | Headings, values, important instructions |
| `--text-secondary` | `#C0C6CE` | `#39424D` | Body copy, navigation, descriptions |
| `--text-muted` | `#969FA9` | `#505C69` | Timestamps, supporting metadata, placeholders |
| `--focus` | `#D3DCE8` | `#354D6B` | Keyboard focus outline |

`--border` is deliberately subtle. It must never be the sole indicator of an input, selection, error, or interactive target.

### Silver tokens

Identical in both themes.

| Property | Value | Role |
|---|---|---|
| `--silver` | `#CCD2D9` | Primary button fill |
| `--silver-hover` | `#E3E6EA` | Hover fill |
| `--silver-pressed` | `#B8BEC6` | Pressed fill |
| `--silver-ink` | `#15181C` | Text and icons on silver |
| `--silver-edge` | `#505C69` | Silver-button boundary |
| `--metal-a` | `#C6CCD3` | Gradient start |
| `--metal-b` | `#E3E6EA` | Broad highlight |
| `--metal-c` | `#CDD3DA` | Fine tonal transition |
| `--metal-d` | `#D5DAE0` | Gradient end |

The brushed-metal suggestion is exactly:

```css
--metal: linear-gradient(112deg,
  var(--metal-a) 0%,
  var(--metal-b) 38%,
  var(--metal-c) 40%,
  var(--metal-d) 100%);
```

Use it only on the approval’s Yes button and, optionally, the Guard receipt’s small summary emblem. Maximum one metal element per screen. No photographic texture, noise, animated sheen, metallic text, or gradient card backgrounds. Ordinary primary buttons use flat silver.

### Status tokens

| Meaning | Foreground, dark | Background, dark | Foreground, light | Background, light |
|---|---|---|---|---|
| Safe | `#A9CEBC` | `#182B24` | `#285E46` | `#E7F1EB` |
| Warning | `#E1C38C` | `#30281A` | `#725014` | `#F8EEDB` |
| Danger | `#E4ADB3` | `#321F25` | `#8A3543` | `#F8E8EB` |
| Info | `#B2C8E0` | `#1D2938` | `#365A80` | `#E8EFF7` |

Names are `--safe`, `--safe-bg`, `--warning`, `--warning-bg`, `--danger`, `--danger-bg`, `--info`, and `--info-bg`.

Inside tinted banners and badges, **all text and icons use that status foreground**. Do not put muted neutral text inside them. On neutral surfaces, status foregrounds may also identify inline results or field errors.

### Verified contrast

Ratios below were calculated from the specified opaque sRGB colors using WCAG relative luminance. Basalt requires at least **4.5:1 for all text**, including supporting text, and **3:1 for essential control boundaries and graphics**. These thresholds follow [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

Each cell lists dark / light. Background columns follow the token names, rather than visual brightness.

| Foreground | `--bg-0` | `--bg-1` | `--bg-2` | `--bg-3` |
|---|---:|---:|---:|---:|
| `--text` | 17.53 / 15.83 | 16.46 / 17.30 | 15.02 / 14.83 | 13.13 / 13.50 |
| `--text-secondary` | 11.24 / 9.33 | 10.55 / 10.19 | 9.63 / 8.74 | 8.42 / 7.96 |
| `--text-muted` | 7.21 / 6.25 | 6.76 / 6.83 | 6.17 / 5.86 | 5.40 / 5.33 |
| `--edge`¹ | 5.42 / 4.25 | 5.09 / 4.64 | 4.65 / 3.98 | 4.06 / 3.62 |
| `--focus`¹ | 13.96 / 7.92 | 13.11 / 8.66 | 11.96 / 7.43 | 10.46 / 6.76 |

¹ Boundaries and focus indicators only; never use these tokens for text.

| Status foreground | Own tinted background, dark / light | Lowest ratio across all four neutral backgrounds, dark / light |
|---|---:|---:|
| Safe | 8.68 / 6.54 | 8.44 / 5.90 |
| Warning | 8.58 / 6.35 | 8.54 / 5.71 |
| Danger | 8.04 / 6.64 | 7.53 / 6.14 |
| Info | 8.57 / 6.18 | 8.43 / 5.59 |

| Silver-ink background | Ratio, both themes |
|---|---:|
| Silver default | 11.69 |
| Silver hover | 14.22 |
| Silver pressed | 9.51 |
| Metal stop A | 11.01 |
| Metal stop B | 14.22 |
| Metal stop C | 11.81 |
| Metal stop D | 12.66 |

The gradient’s lowest text contrast is 11.01:1. `--silver-edge` has at least 3.81:1 against every silver fill and gradient stop.

These are the permitted foreground/background combinations. New combinations require a fresh contrast calculation.

## 3. Typography

### Font stacks

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", Consolas,
  "Liberation Mono", monospace;
```

No web fonts. Do not imitate a terminal.

Sizes below assume a 16px browser default. Implement in `rem` so owner font preferences remain effective.

| Role | Size / line height | Weight | Letter spacing |
|---|---|---:|---:|
| Metadata, badge, field label | 14 / 20px | 400; labels and badges 600 | 0 |
| Body, button, navigation | 16 / 24px | 400; buttons 600 | 0 |
| Lead paragraph | 18 / 28px | 400 | 0 |
| Card or banner heading | 20 / 28px | 600 | −0.01em |
| Section heading | 24 / 32px | 600 | −0.01em |
| Page title, approval question | 32 / 40px | 600 | −0.02em |
| Stat value, stage title | 40 / 48px | 600 | −0.02em |
| Optional single hero number | 48 / 56px | 600 | −0.02em |

Rules:

- Body text uses `--text-secondary`; headings use `--text`.
- Body paragraphs stop at 65 characters per line.
- No uppercase headings. Uppercase is reserved for the specified result badges.
- Stats use `font-variant-numeric: tabular-nums lining-nums` and weight 600. Use locale-aware separators.
- Missing data is written as “Not measured” or “No visits yet.” Never substitute `0` or `100%`.
- Monospace is limited to IDs, literal field names, commands, and technical evidence. Minimum 14/20px; minimum 18/28px in stage details.
- Emails, app names, and owner-facing explanations remain sans serif. Wrap long identifiers; never truncate a decision’s recipient or app name.

## 4. Geometry and behavior

| Property | Specification |
|---|---|
| Spacing | 4, 8, 12, 16, 20, 24, 32, 48, 64px |
| Page gutters | 32px at ≥768px; 16px below |
| Content width | 1200px maximum, centered inside the main region |
| Sidebar | 232px wide |
| Radius | 4px badges; 8px controls; 12px cards; 16px approval card |
| Borders | 1px standard; 3px status accent and focus outline |
| Control height | 44px minimum; approval answers 52px minimum |
| Interactive separation | At least 8px |
| Icons | One outline family; 20px, 1.75px stroke; 24px in stage mode |
| Elevation | Cards are flat. Menus and drawers receive the overlay shadow only |
| Dark overlay shadow | `0 12px 32px #00000066` |
| Light overlay shadow | `0 12px 32px #171B2026` |
| Scrim | Dark `#000000B3`; light `#171B2080` |
| Layers | Base 0; sticky header 10; scrim 20; drawer/menu 30; stage panel 40 |

**Focus:** 3px solid `--focus`, offset 3px. Interactive controls must sit on neutral surfaces so the focus pair remains within the verified combinations. Keep at least 8px clearance around focusable items. Never clip the ring.

**Motion:** 160ms, `cubic-bezier(0.2, 0, 0, 1)`, for color, background, and border changes only. No moving cards, scaling buttons, pulsing status dots, count-up statistics, shimmer, or animated checks.

With reduced motion enabled, remove transitions and animation; use instant state changes and static progress text. Progress must be understandable without motion.

## 5. Components

### App shell and sidebar

Desktop, ≥1024px:

- Two columns: 232px sidebar and remaining main area.
- Sidebar uses `--bg-1`, 1px `--border` on the right, and 16px padding.
- Logo row is 44px tall, followed by 24px before navigation.
- Navigation targets are at least 44px high, with 12px horizontal padding, 12px icon/text gap, and 4px between items.
- Default: secondary text, transparent background.
- Hover: primary text on `--bg-2`.
- Current page: primary text, weight 600, `--bg-3`, and a 1px `--edge` outline. Set `aria-current="page"`.
- Theme control follows the navigation at the bottom and says “Switch to light mode” or “Switch to dark mode.”

Navigation order: Overview, Visitors, Speed & errors, Data map, Safety checks, Updates, Activity log. The Overview contains an attention section linking to unresolved problems.

Below 1024px, replace the sidebar with a 44px labeled **Menu** button. It opens a 232px drawer over a scrim. Trap focus while open; Escape and the scrim close it; restore focus to Menu. The page underneath must be inert.

### Page header

- App/environment strip first: app selector, readable “Live” badge, and environment name.
- Separate the page title from the strip by 24px.
- Title uses 32/40px; description 16/24px with 8px gap.
- One primary page action at most. Align actions right on wide screens; wrap below the description on narrow screens.
- Display the friendly app name prominently. Put hostnames in secondary copy.
- Say “Production · Customers use this version,” rather than relying on “prod.”

### Status banner

- 24px padding, 12px radius, 16px icon/content gap.
- Status tint background, 1px status border, 3px status border on the left.
- 24px icon; heading 20/28px; body 16/24px, separated by 4px.
- Entire text uses the corresponding status foreground.
- Actions inside a banner are underlined text links using `currentColor`.

| State | Icon | Heading example | Required supporting evidence |
|---|---|---|---|
| Safe | Check in circle | “Latest safety check passed” | Version and check time |
| Attention | Triangle with exclamation | “One check needs your attention” | Uncertainty or pending action |
| Problem | Octagon with exclamation | “A customer could read another customer’s booking” | Scope and next action |

A live site and a passed Guard check are separate facts. The dashboard must not infer “protected” from uptime or absence of errors.

### Stat card

- `--bg-1`, 1px decorative border, 12px radius, 20px padding.
- Minimum height 160px; allow growth.
- Label: 14/20px, weight 600, secondary text.
- Value: 40/48px, primary text, 8px below label.
- Explanatory line: 14/20px, muted text, 4px below value.
- Text values such as “No visits yet” use 24/32px.
- Five columns at ≥1200px; three at 768–1199px; one below 768px. Gap 16px.
- A metric card is static. Add an explicitly labeled link if drill-down is available.
- Loading: “Loading…”; failure: “Couldn’t load” plus Retry.
- For a zero denominator, show “Not measured,” with “No visits in the last 24 hours.” Do not show “Worked fine 100%.”

### Card

- `--bg-1`, 1px `--border`, 12px radius, 24px padding.
- Heading 20/28px; optional description 16/24px, 8px below.
- Header-to-content gap 24px.
- No default shadow or hover treatment.
- Interactive cards are not permitted. Use an explicit button or link inside the card.

Traffic charts use secondary neutral for answered requests, warning for blocked attempts, and danger for errors. Use solid, dashed, and dotted strokes respectively; include text labels and a data-table alternative. With no data, show an explanatory empty state instead of empty axes.

### Table and list row

- Header: 14/20px, weight 600, secondary text.
- Standard row: minimum 72px; 16px vertical and horizontal padding.
- Primary row text: 16/24px, weight 600. Evidence: 16/24px, secondary.
- Separate rows with 1px decorative borders.
- Hover styling applies only to interactive rows: `--bg-2`.
- Expanded or selected row: `--bg-3`, with explicit “Expanded” or “Selected” semantics.
- Disclosure buttons say “Show details” and “Hide details”; keep full evidence keyboard-accessible.
- At narrow widths, stack columns into labeled fields. Keep the record name first and actions last.
- Do not make a whole row clickable when it contains other controls.

### Buttons

All buttons use 16/24px, weight 600, 8px radius, 12px horizontal padding, minimum 44px height, and an 8px icon gap. Text may wrap, increasing height.

| Variant | Default | Hover | Pressed |
|---|---|---|---|
| Primary silver | Silver fill, silver ink, silver-edge border | Silver-hover fill | Silver-pressed fill |
| Secondary | Bg-1, primary text, edge border | Bg-2 | Bg-3 |
| Quiet | Transparent, primary text, transparent border | Bg-2 | Bg-3 |
| Danger | Danger tint, danger foreground and border | Underline label | Underline plus inset edge |

Every pressed button also receives a 1px inset edge in its current text color. No movement.

- Disabled: bg-3, muted text, edge border, no opacity reduction, no shadow; use actual disabled semantics.
- Busy: retain width, set `aria-busy="true"`, prevent repeat submission, and replace the label with an explicit verb: “Approving…”, “Connecting…”, or “Running checks…”.
- Error: restore the action and show a nearby explanation. Never leave a failed operation looking complete.
- Links navigate. Buttons perform actions. Quiet buttons are not substitutes for links.
- Danger is reserved for destructive actions, not for declining a request.

### Badges

Badges are labels, never buttons. Use 14/20px, weight 600, 4px radius, 4px vertical/8px horizontal padding, 1px status border, and an 8px icon gap.

| Label | Treatment | Meaning |
|---|---|---|
| **REFUSED** | Safe tint; shield/check icon | An unauthorized attempt was demonstrably denied |
| **LEAKED** | Danger tint; octagon/exclamation | A test exposed unauthorized data or access; describe the exact outcome |
| **CAN’T TELL** | Warning tint; question icon | Evidence is insufficient, interrupted, or unavailable |
| **WORKS** | Info tint; check icon | An authorized operation succeeded as expected |
| **Live** | Bg-3, primary text, edge border; neutral dot | The app is serving requests |
| **Waiting** | Warning tint; clock icon | A decision or prerequisite is pending |

A `404` alone does not prove a security refusal. Without supporting evidence, label it **CAN’T TELL**. An authorized positive control labeled **WORKS** does not belong in the count of attacks refused.

### Approval decision card: highest priority

This is a standalone page, without sidebar, charts, promotional copy, or competing navigation.

**Layout**

- Page uses bg-0; decision card uses bg-1, decorative border, 16px radius.
- Card width: maximum 680px, centered horizontally.
- Top margin: 64px desktop, 24px mobile. Do not vertically center.
- Padding: 32px desktop, 24px below 768px.
- Small Basalt wordmark first, then 24px before the context.
- Context line: “Shear Joy Five · Production,” 14/20px, secondary.
- Question: 32/40px, weight 600, 16px below context.
- Consequence block: warning banner, 24px below question.
- Decision buttons: 24px below consequence, 12px apart; both 52px minimum height.
- Desktop: Yes followed by No, equal-width columns.
- Below 768px: stack Yes then No, both full-width.
- Nothing essential is hidden in a tooltip or collapsed detail.

**Exact admin example**

> **Make owner@shearjoy-demo.example an admin of Shear Joy Five?**
>
> An admin can see and change all customer information saved in this app. This applies to the production app your customers use. Approve only if you trust this person with that access.

Buttons:

- **Yes, make them an admin**: primary silver; the permitted metal treatment.
- **No, keep access unchanged**: secondary.

The full recipient and app name remain visible above the buttons. Never abbreviate the email or mask it with an avatar.

**Rules approval**

Use “Publish these access rules for Shear Joy Five?” followed by a human-readable **Before / After** list. Each changed rule states the person or role, action, and affected records. “View technical details” may follow the complete plain-language explanation.

**Decision behavior**

- Neither answer receives automatic focus. Initial focus goes to the question with `tabindex="-1"`.
- Enter must not approve unless the owner has focused and activated Yes.
- During submission, prevent both answers from being submitted again. Announce “Saving your decision.”
- Success replaces the answers with a persistent result: “Approved. This person is now an admin.” Show the recipient, app, environment, and completion time.
- Decline result: “Declined. Access is unchanged.”
- A network error says “We couldn’t confirm your decision.” Recheck the server’s decision state before allowing another submission.
- Expired, superseded, or already-decided requests show that state in place of the answer controls. Do not offer a stale Yes button.
- Closing the page does not count as declining.

### Form fields

- Visible label above every field, 14/20px, weight 600.
- Label-to-field gap 8px; field-to-hint gap 8px; field-to-field gap 20px.
- Field: bg-1, primary text, 1px edge border, 8px radius, 12px padding, minimum 44px height.
- Placeholder: muted; it never carries required instructions.
- Hover: primary-text border. Focus: shared focus ring.
- Invalid: danger border, danger message below, `aria-invalid="true"` and `aria-describedby`.
- Disabled: bg-3, muted text, no opacity reduction. Read-only retains normal contrast and includes “Read only” in the label.
- Password and token fields have a labeled Show/Hide control. Copying announces “Copied” without moving focus.
- Textareas start at 128px tall and resize vertically.
- Do not validate untouched fields on page load.

### Empty states

Inside the normal card, use 32px padding, left alignment, a 24px neutral icon, a 20/28px heading, and a 16/24px explanation. Maximum one action.

Examples:

- “No visits yet” / “Visits will appear here after someone opens your app.” / **Open app**
- “No safety checks yet” / “Run Guard to test this version’s access rules.” / **Run safety check**
- “Couldn’t load visits” / “Try again to see the latest numbers.” / **Retry**

Keep loading, empty, error, and confirmed zero visibly distinct.

### Data map

- Use a left-to-right reading order: **People → Access rules → Saved information**.
- Nodes use standard cards; connectors use `--edge`, 2px wide, with arrowheads. Every connector has a visible action label: “Can read,” “Can change,” or “Cannot access.”
- Each data card lists its plain-language name, stored fields, and a **Personal info** info badge where applicable.
- Example: “Bookings” → “Customer name · Email · Appointment time.”
- State the enforcement boundary plainly: “The database applies these access rules.”
- Provide an equivalent list view containing the same people, actions, and information.
- Below 768px, use that list as the default. No required panning or dragging.
- Unknown access is a warning labeled “Access not confirmed.” Do not draw a reassuring locked connector.

### Guard safety receipt

Lead with a scoped result, such as **“9 of 9 attempted attacks were refused.”**

Immediately show the app, environment, tested version, completion time with timezone, and counts for refused, leaked, inconclusive, and not-run tests.

Each evidence row contains:

1. Attempt in ordinary language.
2. Result badge.
3. Observed result.
4. Expandable technical evidence.

Put authorized **WORKS** checks in a separate “Normal use” section. Keep unsuccessful and inconclusive outcomes visible in the default view. An incomplete run says “Check incomplete” and identifies the untested portion.

Use the scope sentence: **“This receipt describes these checks against this version.”**

### Connect Claude

Use a maximum 680px content column with the standard page header and cards.

Present three numbered steps: **Open Claude Code → Connect Basalt → Confirm connection**. Keep the owner’s app and environment visible. Commands use the monospace block, with a separate 44px Copy button.

Describe the access being requested before connecting. Only show **Connected** after a verified response. Show “Waiting for Claude” while pending and a recoverable error if verification fails.

### Stage demo panel

The stage panel is a dedicated presentation view, not a scaled dashboard.

- Full viewport, bg-0, no sidebar, no decorative gradient.
- Inner content maximum 1120px; 32px outer padding.
- Stage heading: 40/48px. Introduction: 20/28px. Result summary: 32/40px.
- Summary remains primary neutral text; a status icon carries the outcome color.
- Row: minimum 104px, 16px vertical padding, 24px column gap.
- Badge column: 160px. Badge text: 18/28px.
- Attempt title: 24/32px. Observed result: 20/28px, secondary.
- No muted text for evidence. Technical details are optional and at least 18/28px.
- Close is a labeled 44px secondary button in the header’s right column; it never overlays text.
- Show every result on one screen, in two columns at ≥1024px and one column below, so the presenter never has to click through pages during a live demo. If enlarged text exceeds the available height, the panel scrolls; never shrink type below this spec or clip content.
- Below 768px width, stack badge above evidence and use a 32/40px title.
- If implemented as a modal, use dialog semantics, trap focus, support Escape, make the background inert, and restore focus when closed.
- Never imply a test is finished before its result arrives. Waiting rows say “Waiting,” without a fabricated verdict.

## 6. Ready-to-paste CSS starter

This is a stylesheet specification, not product implementation. Behavior and semantic markup must follow section 5.

All visual values use tokens; structural layout keywords, grid counts, and responsive thresholds remain literal. Light mode follows the device setting; `data-theme="light"` or `"dark"` on the root overrides it. Combine `.badge` or `.banner` with a `.tone--*` class. The stylesheet is under 250 lines.

```css
:root {
  color-scheme: dark;
  --bg-0:#0C0E11; --bg-1:#13161A; --bg-2:#1B1F24; --bg-3:#242A31;
  --border:#353D47; --edge:#7D8996;
  --text:#F2F4F6; --text-secondary:#C0C6CE; --text-muted:#969FA9;
  --focus:#D3DCE8; --clear:#00000000;
  --silver:#CCD2D9; --silver-hover:#E3E6EA; --silver-pressed:#B8BEC6;
  --silver-ink:#15181C; --silver-edge:#505C69;
  --metal-a:#C6CCD3; --metal-b:#E3E6EA; --metal-c:#CDD3DA; --metal-d:#D5DAE0;
  --metal:linear-gradient(112deg,var(--metal-a) 0%,var(--metal-b) 38%,var(--metal-c) 40%,var(--metal-d) 100%);
  --safe:#A9CEBC; --safe-bg:#182B24;
  --warning:#E1C38C; --warning-bg:#30281A;
  --danger:#E4ADB3; --danger-bg:#321F25;
  --info:#B2C8E0; --info-bg:#1D2938;
  --scrim:#000000B3; --shadow:0 12px 32px #00000066;
  --press:inset 0 0 0 1px currentColor;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  --sm:.875rem; --body:1rem; --lead:1.125rem; --h3:1.25rem;
  --h2:1.5rem; --h1:2rem; --display:2.5rem; --hero:3rem;
  --lh-sm:1.25rem; --lh-body:1.5rem; --lh-lead:1.75rem;
  --lh-h2:2rem; --lh-h1:2.5rem; --lh-display:3rem; --lh-hero:3.5rem;
  --regular:400; --semibold:600; --tracking:0; --tight:-.01em; --tighter:-.02em;
  --s0:0; --s1:4px; --s2:8px; --s3:12px; --s4:16px;
  --s5:20px; --s6:24px; --s8:32px; --s12:48px; --s16:64px;
  --r-badge:4px; --r-control:8px; --r-card:12px; --r-decision:16px; --round:50%;
  --line:1px; --line-strong:2px; --ring:3px; --ring-offset:3px;
  --control:44px; --decision-control:52px; --row:72px; --stage-row:104px;
  --icon:20px; --icon-lg:24px; --icon-stroke:1.75px; --dot:8px;
  --sidebar:232px; --content:1200px; --decision:680px; --stage-width:1120px;
  --stat-height:160px; --textarea-height:128px; --badge-column:160px; --measure:65ch;
  --duration:160ms; --ease:cubic-bezier(.2,0,0,1);
  --z-base:0; --z-sticky:10; --z-scrim:20; --z-drawer:30; --z-stage:40;
}
[data-theme="light"] {
  color-scheme:light;
  --bg-0:#F3F5F7; --bg-1:#FFFFFF; --bg-2:#EAEEF2; --bg-3:#DEE4EA;
  --border:#CAD1D9; --edge:#697684;
  --text:#171B20; --text-secondary:#39424D; --text-muted:#505C69; --focus:#354D6B;
  --safe:#285E46; --safe-bg:#E7F1EB;
  --warning:#725014; --warning-bg:#F8EEDB;
  --danger:#8A3543; --danger-bg:#F8E8EB;
  --info:#365A80; --info-bg:#E8EFF7;
  --scrim:#171B2080; --shadow:0 12px 32px #171B2026;
}
* { box-sizing:border-box; }
body { margin:var(--s0); background:var(--bg-0); color:var(--text-secondary); font-family:var(--font-sans); font-size:var(--body); line-height:var(--lh-body); }
button,input,select,textarea { font:inherit; }
button,a,input,select,textarea { touch-action:manipulation; }
h1,h2,h3,p { margin:var(--s0); }
h1,h2,h3 { color:var(--text); font-weight:var(--semibold); }
h1 { font-size:var(--h1); line-height:var(--lh-h1); letter-spacing:var(--tighter); }
h2 { font-size:var(--h2); line-height:var(--lh-h2); letter-spacing:var(--tight); }
h3 { font-size:var(--h3); line-height:var(--lh-lead); letter-spacing:var(--tight); }
p { max-inline-size:var(--measure); }
a { color:var(--text); text-decoration:underline; text-underline-offset:var(--s1); }
:focus-visible { outline:var(--ring) solid var(--focus); outline-offset:var(--ring-offset); }
::selection { background:var(--silver); color:var(--silver-ink); }
.muted { color:var(--text-muted); font-size:var(--sm); line-height:var(--lh-sm); }
.lead { font-size:var(--lead); line-height:var(--lh-lead); }
.numeric { font-variant-numeric:tabular-nums lining-nums; }
code,pre { font-family:var(--font-mono); font-size:var(--sm); line-height:var(--lh-sm); overflow-wrap:anywhere; }
pre { white-space:pre-wrap; padding:var(--s4); margin:var(--s0); background:var(--bg-2); color:var(--text); border-radius:var(--r-control); }
.icon { width:var(--icon); height:var(--icon); flex:none; stroke-width:var(--icon-stroke); }
.app-shell { display:grid; grid-template-columns:var(--sidebar) minmax(0,1fr); min-height:100dvh; }
.sidebar { background:var(--bg-1); border-right:var(--line) solid var(--border); padding:var(--s4); display:flex; flex-direction:column; gap:var(--s6); }
.brand { min-height:var(--control); display:flex; align-items:center; gap:var(--s3); color:var(--text); font-weight:var(--semibold); }
.nav { display:grid; gap:var(--s1); }
.nav__item { display:flex; align-items:center; gap:var(--s3); min-height:var(--control); padding:var(--s2) var(--s3); border:var(--line) solid var(--clear); border-radius:var(--r-control); color:var(--text-secondary); text-decoration:none; }
.nav__item:hover { color:var(--text); background:var(--bg-2); }
.nav__item[aria-current="page"] { color:var(--text); background:var(--bg-3); border-color:var(--edge); font-weight:var(--semibold); }
.sidebar__footer { margin-top:auto; }
.main { min-width:var(--s0); }
.container { max-width:var(--content); margin-inline:auto; padding:var(--s8); display:grid; gap:var(--s6); }
.page-header { display:grid; gap:var(--s6); }
.page-header__context,.actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s3); }
.page-header__main { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s6); }
.page-header__copy { display:grid; gap:var(--s2); min-width:var(--s0); overflow-wrap:anywhere; }
.stack { display:grid; gap:var(--s6); }
.card,.stat,.decision { background:var(--bg-1); border:var(--line) solid var(--border); border-radius:var(--r-card); padding:var(--s6); min-width:var(--s0); }
.card__header { display:flex; justify-content:space-between; align-items:flex-start; gap:var(--s4); margin-bottom:var(--s6); }
.card__description { margin-top:var(--s2); }
.stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:var(--s4); }
.stat { padding:var(--s5); min-height:var(--stat-height); }
.stat__label { font-size:var(--sm); line-height:var(--lh-sm); font-weight:var(--semibold); }
.stat__value { margin-top:var(--s2); color:var(--text); font-size:var(--display); line-height:var(--lh-display); font-weight:var(--semibold); letter-spacing:var(--tighter); font-variant-numeric:tabular-nums lining-nums; }
.stat__value--words { font-size:var(--h2); line-height:var(--lh-h2); }
.stat__note { margin-top:var(--s1); color:var(--text-muted); font-size:var(--sm); line-height:var(--lh-sm); }
.tone--safe { --tone:var(--safe); --tone-bg:var(--safe-bg); }
.tone--warning { --tone:var(--warning); --tone-bg:var(--warning-bg); }
.tone--danger { --tone:var(--danger); --tone-bg:var(--danger-bg); }
.tone--info { --tone:var(--info); --tone-bg:var(--info-bg); }
.banner { display:flex; gap:var(--s4); padding:var(--s6); border:var(--line) solid var(--tone); border-left-width:var(--ring); border-radius:var(--r-card); color:var(--tone); background:var(--tone-bg); }
.banner .icon { width:var(--icon-lg); height:var(--icon-lg); }
.banner h3,.banner p,.banner a { color:inherit; }
.banner p { margin-top:var(--s1); }
.badge { display:inline-flex; align-items:center; gap:var(--s2); width:fit-content; padding:var(--s1) var(--s2); border:var(--line) solid var(--tone); border-radius:var(--r-badge); background:var(--tone-bg); color:var(--tone); font-size:var(--sm); line-height:var(--lh-sm); font-weight:var(--semibold); }
.badge--live { --tone:var(--text); --tone-bg:var(--bg-3); border-color:var(--edge); }
.badge__dot { width:var(--dot); height:var(--dot); border-radius:var(--round); background:currentColor; }
.button { display:inline-flex; justify-content:center; align-items:center; gap:var(--s2); min-height:var(--control); padding:var(--s2) var(--s3); border:var(--line) solid var(--edge); border-radius:var(--r-control); background:var(--bg-1); color:var(--text); font-weight:var(--semibold); text-align:center; text-decoration:none; cursor:pointer; transition:background-color var(--duration) var(--ease),color var(--duration) var(--ease),border-color var(--duration) var(--ease); }
.button:hover { background:var(--bg-2); }
.button:active { background:var(--bg-3); box-shadow:var(--press); }
.button--primary { background:var(--silver); color:var(--silver-ink); border-color:var(--silver-edge); }
.button--primary.metal { background:var(--metal); }
.button--primary:hover { background:var(--silver-hover); }
.button--primary:active { background:var(--silver-pressed); }
.button--quiet { background:var(--clear); border-color:var(--clear); }
.button--danger { background:var(--danger-bg); color:var(--danger); border-color:var(--danger); }
.button--danger:hover,.button--danger:active { background:var(--danger-bg); text-decoration:underline; }
.button:disabled,.button[aria-disabled="true"] { background:var(--bg-3); color:var(--text-muted); border-color:var(--edge); box-shadow:none; text-decoration:none; cursor:default; }
.button[aria-busy="true"] { cursor:progress; }
.list { margin:var(--s0); padding:var(--s0); list-style:none; }
.row { min-height:var(--row); display:grid; gap:var(--s2); padding:var(--s4); border-bottom:var(--line) solid var(--border); }
.row__title { color:var(--text); font-weight:var(--semibold); }
.row--interactive:hover { background:var(--bg-2); }
.row[aria-selected="true"],.row.is-expanded { background:var(--bg-3); }
.table { width:100%; border-collapse:collapse; text-align:left; }
.table th { font-size:var(--sm); line-height:var(--lh-sm); font-weight:var(--semibold); }
.table th,.table td { padding:var(--s4); border-bottom:var(--line) solid var(--border); vertical-align:top; }
.table td { height:var(--row); }
.decision-page { padding:var(--s16) var(--s4); }
.decision { max-width:var(--decision); margin-inline:auto; padding:var(--s8); border-radius:var(--r-decision); display:grid; gap:var(--s6); }
.decision__context { font-size:var(--sm); line-height:var(--lh-sm); }
.decision__question { margin-top:var(--s4); overflow-wrap:anywhere; }
.decision__actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s3); }
.decision__actions .button { min-height:var(--decision-control); }
.form { display:grid; gap:var(--s5); }
.field { display:grid; gap:var(--s2); }
.field__label { color:var(--text); font-size:var(--sm); line-height:var(--lh-sm); font-weight:var(--semibold); }
.field__input { width:100%; min-height:var(--control); padding:var(--s3); color:var(--text); background:var(--bg-1); border:var(--line) solid var(--edge); border-radius:var(--r-control); }
.field__input::placeholder { color:var(--text-muted); opacity:1; }
.field__input:hover { border-color:var(--text); }
.field__input[aria-invalid="true"] { border-color:var(--danger); }
.field__input:disabled { background:var(--bg-3); color:var(--text-muted); border-color:var(--edge); opacity:1; }
textarea.field__input { min-height:var(--textarea-height); resize:vertical; }
.field__hint,.field__error { font-size:var(--sm); line-height:var(--lh-sm); }
.field__hint { color:var(--text-muted); }
.field__error { color:var(--danger); }
.empty { display:grid; justify-items:start; gap:var(--s3); padding:var(--s8); }
.empty .icon { width:var(--icon-lg); height:var(--icon-lg); }
.empty .button { margin-top:var(--s1); }
.map { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s6); }
.map__connector { color:var(--edge); stroke:currentColor; stroke-width:var(--line-strong); }
.map__label { color:var(--text); font-size:var(--body); }
.connect { max-width:var(--decision); width:100%; }
.overlay { box-shadow:var(--shadow); z-index:var(--z-drawer); }
.scrim { position:fixed; inset:0; background:var(--scrim); z-index:var(--z-scrim); }
.menu-trigger { display:none; }
.stage { position:fixed; inset:0; overflow:auto; z-index:var(--z-stage); background:var(--bg-0); padding:var(--s8); }
.stage__inner { max-width:var(--stage-width); margin-inline:auto; display:grid; gap:var(--s6); }
.stage__header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--s6); align-items:start; }
.stage__copy { display:grid; gap:var(--s2); }
.stage h1 { font-size:var(--display); line-height:var(--lh-display); }
.stage__intro { font-size:var(--h3); line-height:var(--lh-lead); }
.stage__summary { color:var(--text); font-size:var(--h1); line-height:var(--lh-h1); font-weight:var(--semibold); }
.stage .row { min-height:var(--stage-row); grid-template-columns:var(--badge-column) minmax(0,1fr); gap:var(--s6); padding-inline:var(--s0); align-items:start; }
.stage .badge { font-size:var(--lead); line-height:var(--lh-lead); }
.stage .row__title { font-size:var(--h2); line-height:var(--lh-h2); }
.stage .row__evidence { margin-top:var(--s1); font-size:var(--h3); line-height:var(--lh-lead); color:var(--text-secondary); }
.stage code,.stage pre { font-size:var(--lead); line-height:var(--lh-lead); }
.stage .icon { width:var(--icon-lg); height:var(--icon-lg); }
.stage__footer { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--s4); }
@media (max-width:1199px) {
  .stats { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@media (max-width:1023px) {
  .app-shell { display:block; }
  .sidebar { display:none; }
  .sidebar.is-open { display:flex; position:fixed; inset-block:0; left:0; width:var(--sidebar); max-width:100%; z-index:var(--z-drawer); box-shadow:var(--shadow); overflow:auto; }
  .menu-trigger { display:inline-flex; }
}
@media (max-width:767px) {
  .container { padding:var(--s4); }
  .page-header__main { flex-direction:column; }
  .stats,.map { grid-template-columns:minmax(0,1fr); }
  .decision-page { padding-top:var(--s6); }
  .decision { padding:var(--s6); }
  .decision__actions { grid-template-columns:minmax(0,1fr); }
  .stage { padding:var(--s4); }
  .stage h1 { font-size:var(--h1); line-height:var(--lh-h1); }
  .stage .row { grid-template-columns:minmax(0,1fr); gap:var(--s3); }
}
@media (prefers-reduced-motion:reduce) {
  *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; }
}
```

## 7. Do / don’t

| # | Do | Don’t |
|---|---|---|
| 1 | Keep brand expression black and silver | Use green as the brand color |
| 2 | Attach safety statements to evidence and a version | Say “Everything is protected” from an uptime signal |
| 3 | Explain the person, action, information, and environment | Ask owners to approve unexplained rules or JSON |
| 4 | Keep Yes and No readable and adjacent | Hide, diminish, or color No as dangerous |
| 5 | Name inconclusive and untested checks | Count errors or missing endpoints as refused attacks |
| 6 | Pair status words with distinct icons | Rely on red versus green |
| 7 | Show “Not measured” when there is no denominator | Show a reassuring 100% without observations |
| 8 | Preserve complete identities and decision text | Truncate emails, app names, or consequences |
| 9 | Use flat surfaces and one restrained metal highlight | Add glass, glows, bevels, noise, or animated sheen |
| 10 | Fit stage results in two readable columns | Shrink the entire interface to fit more rows |

### Pre-ship checklist

- [ ] Every rendered foreground/background pair matches the permitted contrast combinations in both themes.
- [ ] Status information remains understandable in grayscale.
- [ ] All controls have at least 44px targets and visible, unclipped keyboard focus.
- [ ] Keyboard navigation, drawer/dialog focus management, and focus restoration work.
- [ ] At 200% text size and a 320px-wide viewport, essential content reflows without clipping or horizontal page scrolling.
- [ ] Approval displays the complete recipient, app, environment, consequence, and both answers.
- [ ] Approval cannot submit through an unfocused Enter key, double activation, or a stale request.
- [ ] Busy, uncertain, declined, approved, expired, and already-decided states are distinct and announced.
- [ ] Guard totals separate attacks, positive controls, inconclusive results, and unrun tests.
- [ ] Live status never substitutes for a safety-check result.
- [ ] Data-map relationships have equivalent readable text and identify personal information.
- [ ] Loading, empty, unavailable, and measured-zero states are distinct.
- [ ] Charts have labeled series and an accessible data alternative.
- [ ] Reduced-motion mode contains no animation or transition.
- [ ] Stage mode is checked at 1280×720 and 1920×1080, then viewed on the actual projector from the back of the room.
- [ ] No unapproved fonts, colors, gradients, or component variants have been introduced.

Contrast values are calculated; browser, assistive-technology, interaction, and projector checks remain implementation acceptance work.
