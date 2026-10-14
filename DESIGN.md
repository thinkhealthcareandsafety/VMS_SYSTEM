---
name: Marquis & St. Regis Security Desk
description: One house livery for the shared visitor desk of Marriott Marquis New Delhi and St. Regis New Delhi.
colors:
  stone-ground: "#f3f3f1"
  surface: "#ffffff"
  surface-raised: "#fafaf9"
  sunken: "#ececea"
  hairline: "#e2e2df"
  hairline-strong: "#cacac5"
  ink: "#151515"
  ink-hover: "#2e2e2d"
  ink-soft: "#efefec"
  text-secondary: "#4b4b4a"
  text-tertiary: "#686866"
  marquis-red: "#9c1c2e"
  marquis-red-on-ink: "#d0424f"
  regis-silver: "#a8a8a8"
  silver-soft: "#ededeb"
  live-green: "#12704f"
  live-green-soft: "#e4f2ea"
  vermilion: "#c23a17"
  vermilion-soft: "#fcede7"
  amber: "#8f5206"
  amber-soft: "#faf0e0"
typography:
  display:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif"
    fontSize: "84px"
    fontWeight: 500
    lineHeight: 0.9
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.005em"
  title:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'ss01', 'cv11'"
  body-guard:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  section:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  label:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  framed-label:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.16em"
  figure:
    fontFamily: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.03em"
    fontFeature: "'tnum'"
  mono:
    fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace"
    fontSize: "0.92em"
    fontWeight: 400
    letterSpacing: "-0.01em"
rounded:
  frame: "0px"
  sm: "8px"
  md: "10px"
  guard: "12px"
  lg: "14px"
  card: "18px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  card: "18px"
  section: "20px"
  page: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-ghost-hover:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
  button-success:
    backgroundColor: "{colors.live-green}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "38px"
  button-danger:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "38px"
  button-danger-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.vermilion}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  button-guard-action:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "0 22px"
    height: "56px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  input-guard:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.guard}"
    padding: "0 12px"
    height: "48px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "34px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
  framed-label:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.framed-label}"
    rounded: "{rounded.frame}"
    padding: "0 8px"
    height: "22px"
  framed-label-on-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.framed-label}"
    rounded: "{rounded.frame}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "18px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "18px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  badge-live:
    backgroundColor: "{colors.live-green-soft}"
    textColor: "{colors.live-green}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
  pass-number:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.display}"
    rounded: "{rounded.frame}"
    padding: "4px 14px 2px"
---

# Design System: Marquis & St. Regis Security Desk

## Overview

**Creative North Star: "One House Livery, Two Hotels"**

The desk is the complex's own instrument, worn in the livery the two hotels share. St. Regis lends the restraint: stone, white, near-black ink, a silver hairline, and a bold sans that speaks only in titles and names. Marriott Marquis lends the signature: its red, and the thin red frame it draws around MARQUIS, used here around the one label that says where you are (the gate, the security desk, the pass number). Everything a person operates is ink; red is never a control.

Density is operational. The guard works one-handed on a phone or a gate tablet with 48px fields and 56px actions on a stone ground; the admin works at a desk in a sidebar console with hairline tables, tabular figures, and a sticky page head. Hosts and guests never see a generic tool: they open a page headed by both full hotel logos, divided by a silver hairline. No admin-set site name appears on host, guest, or printed-pass surfaces; the two logos are the name.

The system is flat-leaning and quiet. White cards sit on stone with a hairline border and a barely-there shadow. State colours (live green, amber, vermilion) are reserved for state and always arrive with a word and usually an icon. The world rejects the SaaS look it replaced: no teal, no tinted gradient cards, no second accent.

**Key Characteristics:**
- Stone ground, white surfaces, ink for every interaction.
- Marriott red as signature only: logos, the red frame, selection ticks, chart bars, the active nav icon.
- St. Regis silver as ornament only: the hairline between the two marks.
- Geist (600) for titles, names and the pass number; Geist for everything operated.
- One framed label per view naming the place, in tracked capitals.
- Co-brand marks on operating surfaces; both full logos on host, guest and sign-in surfaces.

## Colors

A near-monochrome stone-and-ink palette carrying one crimson signature and a thread of silver, with state colours held strictly to state.

### Primary
- **House Ink** (#151515): the colour of operation. Primary buttons, selected chips and segmented items, switches when on, checkbox accents, focus outline (2px, 2px offset), input focus border, text caret, progress bars, the pass header and pass chip, toasts. Also the body text colour.
- **Ink Lifted** (#2e2e2d): primary button hover only.
- **Ink Wash** (#efefec): the selected-row and picked-host ground, behind ink text.

### Secondary
- **Marquis Crimson** (#9c1c2e): the signature. The framed label's 1px border, the tick on a selected host, admin chart bars, the active sidebar item's icon, the Marriott logo itself. Never a fill behind text, never a button, never a selected state.
- **Crimson on Ink** (#d0424f): the same frame redrawn for ink grounds: the frame around the pass number and the on-ink framed label on the sign-in panel.

### Tertiary
- **Regis Silver** (#a8a8a8): the 1px hairline between the Marriott and St. Regis marks (at 0.6-0.7 opacity) and the small icons in the sign-in panel's foot. Never text.
- **Silver Mist** (#ededeb): the returning-visitor banner ground.

### Neutral
- **Stone Ground** (#f3f3f1): the page ground of every app; the admin page head is this stone at 88% with a blur.
- **Gallery White** (#ffffff): cards, panels, inputs, dialogs, drawers, the guard top bar (90% with a blur).
- **Raised White** (#fafaf9): table headers, sidebar, hover rows, dropzones and camera tiles.
- **Sunken Stone** (#ececea): avatars, empty-state icon wells, segmented-control tracks, ghost hover.
- **Hairline** (#e2e2df): every card, panel and row divider.
- **Hairline Strong** (#cacac5): button and input borders, dashed perforation and dropzone edges.
- **Graphite** (#4b4b4a): secondary text, field labels.
- **Pewter** (#686866): tertiary text, meta lines, table header labels, placeholders.

### State
- **Live Green** (#12704f, soft #e4f2ea): live dot, on-premises and approved badges, completed section numbers, success buttons.
- **Vermilion** (#c23a17, soft #fcede7): errors (invalid fields, needs-attention cards, failure badges and counts) and the evacuation action. Always with words.
- **Amber** (#8f5206, soft #faf0e0): awaiting host, force checked out, warnings.

### Named Rules
**The Ink Operates Rule.** Anything a person can press, select, toggle or focus is ink. If red appears on a control, it is wrong.

**The Signature Rule.** Marquis Crimson draws lines and marks, never fields: a 1px frame, a tick, a chart bar, an icon stroke, a logo. Red never means "selected".

**The Silver Hairline Rule.** Silver is ornament between the two houses. It is never used for text, where it would fail contrast.

**The Vermilion Is Alarm Rule.** Vermilion belongs to errors and to the evacuation action; nothing decorative borrows it.

## Typography

**Display Font:** Geist 600 (with ui-sans-serif, system-ui)
**Body Font:** Geist (with ui-sans-serif, system-ui, Segoe UI)
**Label/Mono Font:** Geist Mono, for visitor IDs, Aadhaar masks and codes

**Character:** An engraved bold sans that only ever names things (pages, steps, people, the pass number) set against a precise grotesque that carries every operated word. The serif speaks; the sans works.

### Hierarchy
- **Display** (Geist (600) 500, 84px, 0.9): the daily pass number on the on-screen pass, inside its crimson frame. Tabular.
- **Headline** (Geist (600) 500, 26-32px, 1.1-1.15): sign-in title (32px), approval card title (30px), guard step title (28px), outcome title (26px), sign-in panel statement (clamp 30-44px on ink).
- **Title** (Geist (600) 500, 22-24px, 1.2): admin page head (22px), side-panel titles (22px), inside-list head (24px); the pass holder's name (19px) and the co-brand house name (15-17px) use the same voice.
- **Section** (Geist 600, 15-16px, 1.2, -0.015em): card and panel headings, dialog titles (17px).
- **Body** (Geist 400, 14px, 1.5; 15px in the guard app; inputs 16px on the guard so phones do not zoom). Stylistic sets ss01 and cv11 on.
- **Label** (Geist 500, 13px): field labels, segmented items, table headers (12.5px, Pewter).
- **Figure** (Geist 600, 30px, -0.03em, tabular): admin KPI values. Every counted, timed or numbered value uses tabular figures.
- **Framed label** (Geist 500, 10.5px, 0.16em, uppercase): the gate name, "Security desk". Only inside the red frame.

### Named Rules
**The Bold Names Rule.** Geist (600) appears only where something is named: a page, a step, a person, a pass number. Buttons, fields, tables and figures are Geist.

**The Framed Capitals Rule.** Tracked uppercase lives only inside the red frame. Every other label is sentence case at normal tracking.

## Layout

Two working shapes. The guard app is a single column on phones (max content 1200px, 16px gutters, 20px between blocks) with a fixed three-tab bar at the bottom and a sticky send bar at the foot of the form column; from 1000px it becomes a split (form 1.25fr, side 1fr) with a sticky side column and no tab bar. The admin is a 248px sidebar console with a sticky, blurred page head (14px 28px) over a 24px 28px page; KPIs run four across, two across under 1100px, and under 860px the sidebar becomes a scrolling top strip, tables scroll horizontally at a 720px minimum, and the sign-in drops its ink panel for a compact mark row.

The guard top bar holds the co-brand marks, the gate in its frame, and the live line; under 640px it wraps to two rows with the Visitors / Material / Couriers switch on its own full-width row and Scan plus the menu kept top right. Host, approver and guest pages are a single centred card under both full logos.

Spacing runs on a 6 / 8 / 12 / 16 / 18 / 20 / 24 / 28px rhythm: 8px and 6px for inline gaps, 12px inside rows, 16-18px inside cards and panels, 20px between blocks. Tap targets are at least 44px on guard surfaces.

## Elevation & Depth

Hybrid, flat at rest. Depth on working surfaces comes from tonal layering (stone ground, white card, raised-white header, sunken wells) and hairline borders; shadows are faint and ink-tinted. Only floating layers (dialogs, drawers, menus, toasts, the pass) lift with a real shadow. The guard top bar and admin page head are translucent with a 12px backdrop blur.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px rgba(21, 21, 21, 0.05)`): buttons, inputs, cards, panels, the active nav item.
- **Lift** (`box-shadow: 0 1px 2px rgba(21, 21, 21, 0.04), 0 4px 12px -2px rgba(21, 21, 21, 0.07)`): intermediate raised surfaces.
- **Float** (`box-shadow: 0 24px 48px -12px rgba(21, 21, 21, 0.24), 0 4px 12px rgba(21, 21, 21, 0.06)`): dialogs, drawers, menus, toasts, the pass.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(21, 21, 21, 0.12)`): inputs on focus, with an ink border.

### Named Rules
**The Flat Card Rule.** Cards are white on stone with a hairline and the rest shadow. State shows through a badge, a word or a border, never through a tinted or gradient card fill.

## Shapes

Softly rounded working shapes against one square signature. Controls round at 10px (8px small, 12px guard fields and large buttons, 14px guard actions), panels at 14px, cards, camera tiles and the pass at 18px, dialogs at 16px; chips, badges, switches and counters are full pills. The framed label and the pass-number frame are square-cornered 1px rules: the Marquis frame is the one shape in the system with no radius, which is what makes it read as a mark rather than a control. The printed pass is a 72mm receipt, black on white, with a dashed perforation.

## Components

### Buttons
Calm, ink-first, quietly tactile.
- **Shape:** gently rounded (10px; 8px small; 12px large; 14px for 56px guard actions).
- **Primary:** ink fill, white Geist 500 text, 38px tall, 14px side padding, 16px icon with an 8px gap.
- **Hover / Focus:** primary lifts to Ink Lifted; secondary to Raised White. Press nudges down 1px. Focus is the global 2px ink outline at 2px offset. Disabled at 50% opacity.
- **Secondary:** white with a Hairline Strong border and rest shadow. **Ghost:** transparent, Graphite text, Sunken Stone on hover.
- **Success / Danger:** Live Green and Vermilion fills for approve and destructive decisions. **Danger outline** (Vermilion text, light vermilion border) carries the Evacuation list action on the guard desk and admin, with a siren icon.
- **Sizes:** 32 / 38 / 48 / 56px.

### Chips and segmented controls
- **Chips:** 34px pills, white with a strong hairline; selected is ink fill with white text.
- **Segmented:** a Sunken Stone track (3px inset, 10px radius); the pressed item turns white with the rest shadow. The desk switch (Visitors / Material / Couriers) keeps its pressed text ink.

### Cards / Containers
- **Corner Style:** 18px for guard cards, 14px for admin panels.
- **Background:** Gallery White on Stone Ground.
- **Shadow Strategy:** rest shadow (see Elevation & Depth).
- **Border:** 1px Hairline; a card that needs attention takes a Vermilion border and a 3px vermilion-soft halo.
- **Internal Padding:** 18px; panel heads 14px 18px over a hairline.

### Inputs / Fields
- **Style:** white, 1px Hairline Strong border, 10px radius, 40px (48px and 16px text in the guard app, 44px on sign-in). Labels above in Geist 500 13px Graphite; hints 12.5px Pewter.
- **Focus:** border turns ink with the 3px ink focus ring.
- **Error:** Vermilion border, hint text in Vermilion. Digit boxes (mobile, OTP) share the same states.

### Navigation
- **Admin sidebar:** Raised White column, co-brand marks with the house name in bold Geist at the top. Items are 36px, Geist 500, Graphite with 17px icons; hover Sunken Stone; the current page is a white tile with the rest shadow and a hairline inset, its icon in Marquis Crimson. Alert counts are Vermilion pills.
- **Guard tab bar (phones):** three 62px tabs, 22px icons, Pewter at rest and ink when selected, ink count pills.

### Badges and live state
22px pills with a 6px leading dot in the text colour: Live Green for on premises, Amber for awaiting host, Vermilion for declined, neutral for closed states. The live dot is an 8px green dot with a slow ping ring; offline turns it Pewter.

### The Framed Label (signature)
The Marquis frame around the one name that says where you are: 22px tall, 0 8px padding, 1px Marquis Crimson border with square corners, Geist 500 10.5px uppercase at 0.16em in ink. On ink it switches to Crimson on Ink with near-white text. Used for the gate name in the guard top bar and "Security desk" on sign-in. One per view.

### Co-brand marks and lockup (signature)
- **Marks:** the Marriott M and the St. Regis monogram (26px and 30px tall; 22/25px under 560px) divided by a 1px silver hairline, with the house name in bold Geist and "New Delhi" in sentence-case Geist beside them when there is room. Used on the guard top bar, the admin sidebar, the pass header and the compact sign-in mark.
- **Lockup:** both full logos at their own optical heights, divided by a silver hairline. Used on the sign-in ink panel and above the card on host, approver and guest pages. Light versions are used on ink.

### The Visitor Pass (signature)
A key card: an ink header carrying the co-brand marks (on-ink versions) and the daily number in bold Geist 84px inside a Crimson on Ink frame, over a white body with the visitor's photo, their name in bold Geist 19px, two-column details, and a dashed perforation. 18px radius, float shadow; it lands with a short ease-out and the number un-blurs into place. The printed version is a black-on-white 80mm receipt headed by both logos.

## Do's and Don'ts

### Do:
- **Do** make every interactive state ink (#151515): primary buttons, selected chips, switches, focus, carets, progress.
- **Do** keep Marquis Crimson (#9c1c2e) to lines and marks: the framed label, selection ticks, chart bars, the active nav icon, the logos.
- **Do** put the name of the place (gate, desk, pass number) in the square 1px crimson frame, once per view.
- **Do** set titles, people's names and the pass number in Geist (600) 500; set everything operated in Geist.
- **Do** show both hotel logos on host, approver, guest and sign-in surfaces, and the co-brand marks on operating surfaces, in place of any admin-set site name.
- **Do** pair every state colour with a word, and use tabular figures for every counted, timed or numbered value.
- **Do** keep guard fields at 48px with 16px text and guard actions at 56px.

### Don't:
- **Don't** use red for a button, a selected state, a filled badge or body text.
- **Don't** set text in Regis Silver (#a8a8a8).
- **Don't** use Vermilion (#c23a17) for anything but errors and the evacuation action.
- **Don't** tint or gradient-fill a card to show its state; use a badge, a word or a border.
- **Don't** use tracked uppercase outside the framed label.
- **Don't** introduce teal or a second accent hue.
- **Don't** set buttons, fields, tables or figures in Geist (600).
