---
name: frontend-design-nuxt
description: Frontend design conventions for Nuxt/Vue/Pinia/Tailwind stacks.
---

**Category:** Stack skill.

## Accessibility

> The baseline every user-facing interface meets, regardless of framework.

Accessibility is a correctness and legal requirement, not a polish step. Semantic markup, labelled controls, keyboard support, and sufficient contrast are what make an interface usable with assistive technology, and they are far cheaper to build in than to retrofit.

- Meet **WCAG 2.1 Level AA** for all user-facing UI.
- Use semantic HTML elements for their meaning (`button`, `nav`, `main`, `label`, headings in order) rather than styling generic `div`/`span` to imitate them.
- Label every form control programmatically (a `<label>`, `aria-label`, or `aria-labelledby`) and associate errors with their field.
- Support full keyboard operation: every interactive element is reachable and operable with the keyboard, in a logical tab order, with no keyboard traps.
- Keep a visible focus indicator. Do not remove focus outlines without an equally clear replacement.
- Provide meaningful `alt` text for informative images and empty `alt=""` for purely decorative ones.
- Meet WCAG AA contrast ratios: 4.5:1 for normal text, 3:1 for large text and meaningful UI/graphical elements.
- Verify accessibility automatically in CI (the Lighthouse CI accessibility budget for Nuxt apps) and treat regressions as blocking.

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

A single store library with one authoring style keeps shared state predictable and testable. `storeToRefs` exists because destructuring a reactive store otherwise drops reactivity, a common and silent bug.

- Manage shared client-side state with Pinia (via `@pinia/nuxt`). Do not introduce a second state-management library alongside it.
- Define stores with the **setup syntax** (`defineStore('cart', () => { … })`), returning state, getters, and actions.
- Destructure reactive state with `storeToRefs`, because plain destructuring of a store breaks reactivity. Call actions directly on the store instance, not via `storeToRefs`.
- Keep stores free of UI/presentation logic. They hold state and the operations on it, not component concerns.
- Prefer a composable (`useX`) for component-local or feature-scoped state, and reserve Pinia for state genuinely shared across components.

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

Mobile-first styling matches how most users arrive and produces simpler CSS. Reusing the design system's tokens keeps spacing, colour, and typography consistent and avoids the drift ad-hoc CSS introduces. Semantic colour tokens carry intent rather than a fixed shade, so they retheme and switch between light and dark mode automatically.

- Design **mobile-first**: base (unprefixed) styles target the smallest viewport, and larger layouts are layered on with responsive breakpoint utilities (Tailwind `sm:`/`md:`/`lg:` …). Do not write desktop-first layouts.
- Use the framework's utility/styling system (Tailwind via Nuxt UI) and existing design tokens rather than ad-hoc hard-coded colours, spacing, or one-off global CSS.
- Express colour through Nuxt UI's **semantic design tokens** whenever one expresses the intent: the colour aliases (`text-primary`, `bg-primary`, `border-primary`, and the `*-secondary`/`*-success`/`*-info`/`*-warning`/`*-error` equivalents) and the neutral aliases (`text-default`, `text-muted`, `text-dimmed`, `bg-default`, `bg-muted`, `bg-elevated`, `border-default`, `border-muted`, …). Use raw Tailwind colour-scale utilities (`text-neutral-500`, `border-neutral-200`, `bg-gray-100`) only as a **last resort**, when no semantic token fits.
- Scope component styles (`<style scoped>`) and avoid leaking selectors into the global scope.
- Drive responsive behaviour with breakpoints or container queries rather than JavaScript measuring the viewport, which is SSR-unsafe.

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

> Nuxt auto-imports most framework symbols, so explicit imports are redundant and removed unless an exception below applies.

Before removing any explicit import, verify the symbol against `.nuxt/types/imports.d.ts`, `.nuxt/types/nitro-imports.d.ts`, and `.nuxt/types/shared-imports.d.ts`. Remove the import only after confirming the symbol appears in one of those files.

Keep explicit imports where Nuxt's auto-import injection does not reach:

- **Test files** — Vitest resolves aliases through `vitest.config.ts`. Some files under `server/` may also need explicit imports because the test environment does not get Nuxt's auto-import injection.
- **Server utilities importing types via relative paths** — Nuxt does not resolve these imports automatically.
- **Nitro auto-imports** — Nitro does not inject globals, so symbols from the Nitro layer require explicit imports.

## Scope

This skill applies only to repos using Nuxt, Vue, Pinia, Tailwind CSS, and Nuxt UI. Do not configure it for other stacks.
