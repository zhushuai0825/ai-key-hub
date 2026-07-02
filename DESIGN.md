# Key Hub Design System

> Category: Internal Ops / Developer Tools
> Paper-and-ink editorial dashboard. Warm neutral base, amber accent, sharp borders.

## 1. Color

Source of truth: `theme.css` CSS variables. Do not invent new colors.

| Token | Value | Role |
|-------|-------|------|
| `--paper` | `#f3f0ea` | Page background |
| `--paper-2` | `#ebe7df` | Secondary surface |
| `--card` | `#fdfcfa` | Cards, nav, elevated panels |
| `--ink` | `#1c1917` | Primary text, strong borders |
| `--ink-2` | `#44403c` | Secondary text |
| `--muted` | `#78716c` | Labels, metadata |
| `--line` | `#d6d3cd` | Internal dividers |
| `--line-dark` | `#1c1917` | Structural borders |
| `--accent` | `#b45309` | Primary actions, emphasis |
| `--accent-soft` | `#fef3c7` | Accent background tint |
| `--ok` / `--ok-soft` | green pair | Success states |
| `--warn` / `--warn-soft` | amber pair | Warning states |
| `--bad` / `--bad-soft` | red pair | Error / low balance |

## 2. Typography

| Token | Stack |
|-------|-------|
| `--sans` | `-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif` |
| `--mono` | `SF Mono, IBM Plex Mono, Menlo, Consolas, monospace` |

- Body: 14px, line-height 1.55
- Page title (h1): 15–22px, weight 700, tight tracking
- KPI numbers: 22px, tabular-nums, weight 700
- Labels: 11–12px, `--muted`
- API keys / codes: always `--mono`

## 3. Spacing & Layout

- Base rhythm: 16px / 20px / 28px
- Nav height: `--nav-h` (52px), sticky top
- Page padding: 28px horizontal
- Dashboard grid: content-first; KPI row is allowed but must use existing `.kpi-row` pattern (flat bordered strip, not floating cards)
- Two-column main: `1.5fr / 0.85fr` with 16px gap

## 4. Shape & Depth

- Border radius: `--radius: 2px` (sharp, editorial — do not inflate to 12px+)
- Borders: 1px solid `--line` or `--line-dark`
- Shadows: minimal or none; prefer borders over elevation
- No glassmorphism, no gradient backgrounds, no glow

## 5. Components

Reuse existing classes from `theme.css`, `styles.css`, `key.css`:

- `.site-nav` — top navigation
- `.page-intro` — page header (h1 + one-line subtitle only)
- `.kpi-row` / `.kpi` — metric strip
- `.btn` / `.btn-solid` / `.btn-ghost` — actions
- `.panel` — bordered content blocks
- `.table` — data tables

Buttons: solid `--accent` for primary, ghost/outline for secondary. Max radius 2–6px.

## 6. Motion

- Transitions: 100–150ms ease
- Allowed: opacity, background-color, border-color
- Banned: transform on hover, bounce, page-load animations

## 7. Voice (Chinese UI)

- Direct, operational copy — no marketing fluff
- Page titles name the function: "运行总览", "Key 管理"
- Subtitles explain data source or scope in one sentence
- Banned phrases: "一站式", "赋能", "无缝", "智能化体验", "Elevate", "Seamless"

## 8. Brand

- Product name: **Key Hub**
- Context: internal ops console for API key / model vendor management
- Aesthetic reference: printed ops manual + terminal — not SaaS landing page

## 9. Anti-patterns

**Never introduce:**

- Purple/blue AI gradient backgrounds
- Inter font (project uses system sans)
- Floating rounded sidebar shells
- Eyebrow labels above headings
- Decorative hero sections inside dashboard pages
- Glass cards with heavy blur shadows
- Pill buttons everywhere
- Generic 3-column icon feature cards
- Fake charts to fill empty space
- "Live" nav badges without real data
- Rounded 16px+ corners across all components

**Before shipping UI changes**, read `vendor/no-slop-ui/references/banned-patterns.md`.

**Reference systems** (for inspiration only, do not copy colors):

- `vendor/open-design/design-systems/linear-app/DESIGN.md` — precision and hierarchy
- This project's `theme.css` always wins over external references
