---
name: frontend-design-nuxt
description: Frontend design conventions for Nuxt/Vue/Pinia/Tailwind stacks.
---

**Category:** Stack skill.

## Accessibility

> The baseline every user-facing interface must meet, regardless of framework.

- MUST meet **WCAG 2.1 Level AA** for all user-facing UI.
- MUST use semantic HTML elements for their meaning (`button`, `nav`, `main`, `label`,
  headings in order) rather than styling generic `div`/`span` to imitate them.
- MUST make every form control programmatically labelled (a `<label>`, `aria-label`, or
  `aria-labelledby`) and associate errors with their field.
- MUST support full keyboard operation: every interactive element is reachable and operable
  with the keyboard, in a logical tab order, with no keyboard traps.
- MUST keep a visible focus indicator; MUST NOT remove focus outlines without an equally
  clear replacement.
- MUST provide meaningful `alt` text for informative images and empty `alt=""` for purely
  decorative ones.
- MUST meet WCAG AA contrast ratios (4.5:1 for normal text, 3:1 for large text and meaningful
  UI/graphical elements).
- SHOULD verify accessibility automatically in CI (the Lighthouse CI accessibility budget for
  Nuxt apps) and treat regressions as blocking.

Accessibility is a correctness and legal requirement, not a polish step. Semantic markup,
labelled controls, keyboard support, and sufficient contrast are what make an interface usable
with assistive technology — and they are far cheaper to build in than to retrofit.

```vue
<!-- avoid: a div pretending to be a button, no label, focus removed -->
<div class="btn" @click="submit">Save</div>
<input v-model="email" style="outline: none" />

<!-- prefer: real semantics, an associated label, visible focus -->
<button type="button" @click="submit">Save</button>
<label for="email">Email</label>
<input id="email" v-model="email" type="email" />
```

## Client State Management

> How shared client-side state is structured in Nuxt/Vue apps.

- MUST manage shared client-side state with Pinia (via `@pinia/nuxt`); MUST NOT introduce a
  second state-management library alongside it.
- MUST define stores with the **setup syntax** (`defineStore('cart', () => { … })`), returning
  state, getters, and actions.
- MUST destructure reactive state with `storeToRefs`; plain destructuring of a store breaks
  reactivity. Call actions directly on the store instance, not via `storeToRefs`.
- MUST keep stores free of UI/presentation logic — stores hold state and the operations on it,
  not component concerns.
- SHOULD prefer a composable (`useX`) for component-local or feature-scoped state, and reserve
  Pinia for state genuinely shared across components.

A single store library with one authoring style keeps shared state predictable and testable.
`storeToRefs` exists precisely because destructuring a reactive store otherwise drops
reactivity, so making it the rule avoids a common, silent bug.

```ts
// stores/cart.ts — setup-syntax store; no imports needed (auto-imported)
export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItem[]>([]);
  const total = computed(() => items.value.reduce((n, i) => n + i.price, 0));
  function addItem(item: CartItem) {
    items.value.push(item);
  }
  return { items, total, addItem };
});
```

```ts
// in a component: reactive state via storeToRefs, actions on the instance
const cart = useCartStore();
const { items, total } = storeToRefs(cart); // reactive
cart.addItem(item); // action — call on the store, not the refs

// avoid: plain destructuring loses reactivity
const { items } = useCartStore(); // ✗ items will not update
```

## Styling & Responsive Design

> How layouts and styles are built for Nuxt/Vue apps.

- MUST design **mobile-first**: base (unprefixed) styles target the smallest viewport, and
  larger layouts are layered on with responsive breakpoint utilities (Tailwind `sm:`/`md:`/
  `lg:` …). Desktop-first layouts are forbidden.
- MUST use the framework's utility/styling system (Tailwind via Nuxt UI) and existing design
  tokens rather than ad-hoc hard-coded colours, spacing, or one-off global CSS.
- MUST express colour through Nuxt UI's **semantic design tokens** — the colour aliases
  (`text-primary`, `bg-primary`, `border-primary`, and the `*-secondary`/`*-success`/`*-info`/
  `*-warning`/`*-error` equivalents) and the neutral aliases (`text-default`, `text-muted`,
  `text-dimmed`, `bg-default`, `bg-muted`, `bg-elevated`, `border-default`, `border-muted`, …)
  — whenever one expresses the intent. Raw Tailwind colour-scale utilities
  (`text-neutral-500`, `border-neutral-200`, `bg-gray-100`) are a **last resort**, reached for
  only when no semantic token fits.
- SHOULD scope component styles (`<style scoped>`) and avoid leaking selectors into the global
  scope.
- SHOULD keep responsive behaviour driven by breakpoints/container queries rather than
  JavaScript measuring the viewport (which is SSR-unsafe).

Mobile-first styling matches how the majority of users arrive and produces simpler CSS.
Reusing the design system's tokens keeps spacing, colour, and typography consistent and avoids
the drift that ad-hoc CSS introduces. Semantic colour tokens carry intent rather than a fixed
shade, so they retheme and switch between light/dark mode automatically.

```vue
<!-- mobile-first: base styles are the small layout; md: enhances upward -->
<template>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
    <slot />
  </div>
</template>
```

```vue
<!-- avoid: raw colour-scale utilities hard-code a shade the theme can't control -->
<div class="border border-neutral-200 text-neutral-500">…</div>

<!-- prefer: semantic tokens that track the theme and dark mode -->
<div class="border border-default text-muted">…</div>
```

## Auto-Imports

> Nuxt auto-imports most framework symbols; explicit imports are redundant and must be removed unless one of the exceptions below applies.

Before removing any explicit import, verify the symbol against `.nuxt/types/imports.d.ts`, `.nuxt/types/nitro-imports.d.ts`, and `.nuxt/types/shared-imports.d.ts`. Remove the import only after confirming the symbol appears in one of those files.

Explicit imports are appropriate in three circumstances:

- **Test files** — Vitest resolves aliases through `vitest.config.ts`. Some files under `server/` may also need explicit imports because the test environment does not get Nuxt's auto-import injection.
- **Server utilities importing types via relative paths** — Nuxt does not resolve these imports automatically.
- **Nitro auto-imports** — Nitro does not inject globals, so symbols from the Nitro layer require explicit imports.

## Scope

This skill applies only to repos using Nuxt, Vue, Pinia, Tailwind CSS, and Nuxt UI. Do not configure it for other stacks.
