# Design System

> Visual design guidelines for the CEO Coach Portal.

## Foundation

- **Font:** Geist Sans (interface text), Geist Mono (code, IDs, dates, metrics)
- **Colors:** Zinc/neutral palette via shadcn/ui OKLCH CSS variables
- **Radius:** 0.5rem base (`--radius`), variants via `calc()` for sm/md/lg/xl
- **Dark mode:** System default, toggle available — uses `next-themes` with `class` strategy
- **Icons:** Lucide React — 16px (h-4 w-4) for inline, 20px (h-5 w-5) for stat icons

## Color Tokens

All colors are defined in `globals.css` as OKLCH values and mapped to Tailwind via `@theme inline`.

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `background` | white | zinc-950 | Page background |
| `card` | white | zinc-900 | Card surfaces |
| `primary` | zinc-900 | zinc-100 | Buttons, active states |
| `secondary` | zinc-100 | zinc-800 | Secondary buttons, tags |
| `muted` | zinc-100 | zinc-800 | Subtle backgrounds |
| `muted-foreground` | zinc-500 | zinc-400 | Secondary text |
| `border` | zinc-200 | white/10% | Borders, dividers |
| `sidebar` | zinc-50 | zinc-900 | Sidebar background |

### Semantic Status Colors

Used for badges and status indicators — always use opacity-based (`/10`, `/20`) for backgrounds:

| Status | Text | Background |
|--------|------|------------|
| Success/Generated | emerald-600/400 | emerald-500/10 |
| Ready/Action | blue-600/400 | blue-500/10 |
| Warning/Attention | amber-600/400 | amber-500/10 |
| Destructive | red-600/400 | destructive token |

## Layout

- **App shell:** Fixed sidebar (w-60) + topbar (h-14) + scrollable content area
- **Content max-width:** `max-w-5xl` (64rem) centered with `mx-auto px-6 py-8`
- **Sidebar:** Section labels in 11px uppercase tracking-wider, nav items in rounded-lg with 1px spacing

## Component Patterns

### Cards
- Use `<Card>` for all grouped content
- Stats: icon in colored rounded-lg box + metric + label
- Lists: `<Card>` with `<CardHeader>` title + `<Separator>` + `divide-y` rows
- Empty states: centered with icon (in rounded-full bg-muted), title, description, CTA

### Badges
- Default `variant` from shadcn for basic states
- Custom `className` with opacity colors for semantic status (see above)
- Size: `text-[11px]` for compact inline badges

### Buttons
- Primary: default shadcn button
- Icon prefix: `<Plus className="mr-1.5 h-4 w-4" />`
- Sizes: `sm` for page actions, default for form submits

### Tables / Lists
- Use `divide-y divide-border` within a Card for row-based lists
- Hover: `hover:bg-muted/50` on interactive rows
- Avatar circles: `h-9 w-9 rounded-full bg-muted` with initial letter

### Typography
- Page title: `text-2xl font-semibold tracking-tight`
- Page description: `text-sm text-muted-foreground mt-1`
- Section labels: `text-[11px] font-medium uppercase tracking-wider text-muted-foreground`
- Metric values: `text-2xl font-semibold tabular-nums`
- Metric labels: `text-xs text-muted-foreground`

## Spacing

- Page sections: `space-y-8`
- Card internal padding: default shadcn (p-6 for content, adjusted with `py-4` for compact)
- Grid gaps: `gap-4` for stat cards, `gap-3` for form fields

## Component Library

All UI primitives from **shadcn/ui** (New York style). Installed components:

- `button`, `card`, `badge`, `separator`, `dropdown-menu`, `tooltip`

Add more via: `pnpm dlx shadcn@latest add <component>`
