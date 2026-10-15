---
name: figma-implement
description: >-
  Implement UI from Figma frames in any JS framework. Use whenever a task
  references a figma.com link, a page or section design, or a design-system
  component — and always before writing markup for any interactive element or
  any row of items that has to survive a 320 px phone.
argument-hint: '<figma frame link(s)>'
allowed-tools:
  - mcp__figma__get_design_context
  - mcp__figma__get_variable_defs
  - mcp__figma__get_metadata
  - mcp__figma__get_screenshot
  - mcp__figma__list_file_components_for_code_connect
  - Read
  - Edit
  - Write
  - Bash
---

# Figma Implement

Implement this design: $ARGUMENTS

Work the seven steps in order — each produces the input the next one needs, and
the last two are the verification the frames themselves cannot give you.

> **The standing rule.** A static frame shows one state, at one width.
> Checking hover, focus, active and disabled — and checking the narrowest width
> you support — is unconditional, not something to do when you feel uncertain.
> Uncertainty-gated checking cannot catch a question you never thought to ask.
>
> Neither hover nor 320 px has a frame. That is exactly why they are the two
> things that ship broken.

## Step 1 — Read design system context

Read the repo conventions Design system section (surfaced in the review prompt
by `formatRepoConventionsPromptSection`, or infer from `package.json` and
existing source files if absent).

- `framework` — the JS framework in use (nuxt, next, react, vue).
- `configFile` — the design system config file to read for tokens (e.g.
  `app/app.config.ts` for Nuxt UI, `tailwind.config.ts` for Tailwind CSS v3,
  or the global CSS file that declares `@theme` for Tailwind v4).
- `tailwindConfig.mode` — `legacy-file`, `inline-theme`, or `css-variables`.
- `componentLibrary` — the component library in use (`@nuxt/ui`, `shadcn-ui`,
  `@mui/material`, etc.).
- `darkModeConvention` — `tailwind-dark` (use `dark:` prefix) or
  `data-theme-attr` (use `[data-theme="dark"]` selector).

## Step 2 — Read every linked frame

Call `mcp__figma__get_design_context` on each frame link. A ticket can link
anything from a single desktop/mobile pair to a dozen frames spanning several
sections or states. Group them by what they design; take each group as one
implementation unit and read all of it before starting — frames routinely differ
in what they *contain*, not just how it is arranged. Never infer one from
another: a missing width can hide a deliberate design difference. If a group is
missing a width, ask for that frame rather than deriving it.

Each response ends with a `## Component descriptions` block naming every
design-system component in that frame, each with a node ID. Treat the union of
those blocks as the work list: a component recurring across frames is one
implementation, not several.

**For any interactive component:** before writing markup, resolve its variant
states from the design system file. Resolve the master from the page instance's
child IDs — an instance `6:4193` with a child `I6:4193;150:24626` has master
`150:24625`; its siblings in that component set are the other states. If the
project has a design system Figma library, use that file key with the resolved
master node ID (node IDs are file-scoped: a DS node ID passed with a page file
key returns "invalid node selection" — this is not a permissions error).

Call `mcp__figma__get_variable_defs` on each frame node first — it returns token
names and literals compactly. Call `mcp__figma__get_design_context` per node for
layout and structure. Its raw px values (`px-[80px]`) are what Figma stores, not
what to write.

## Step 3 — Map tokens

Map every design value to a token from the detected design system config:

- **Tailwind `legacy-file` or `inline-theme`:** map to Tailwind utility classes.
  Convert raw px to the scale (px ÷ 4 = the Tailwind number; quarter values
  exist). Read the project's breakpoint scale from the config — it may differ
  from Tailwind's defaults.
- **Tailwind `css-variables`:** map to CSS custom property references
  (`var(--token-name)`).
- **`@nuxt/ui`:** map to the `ui` prop or the design system config file color/
  size keys. Design-system primitive styling belongs in the config file under
  `ui.<component>`, not on the call site.
- **`@mui/material` / `@chakra-ui/react`:** map to the theme token path.
- **No token match:** use a literal and leave a `// TODO: add token` note.

When a token's name and its hex value disagree, follow the **name** for colours
(the mismatch is design-system wiring, not a per-component decision) and follow
the **rendered value** for sizes, spacing, radius, and line-height (and raise the
binding with design, because a wrong resolved value is itself the finding).

A registered colour token is registered per CSS property family, not globally.
Confirm the token namespace matches the property (`bg-`, `border-`, `ring-`,
`text-`) before assuming the utility exists.

## Step 4 — Map content to its real source

Figma content is mock. Every string in a frame must come from the data source
(API, CMS, feed). Map each field explicitly. If a value has no field behind it,
ask — prefer omitting the element to fabricating a value, because downstream
consumers cannot tell a fabricated value from a real one.

## Step 5 — Locate or create the target component

Find the existing component file using the frame name and the detected framework
conventions. If no match exists, create a new file following the naming pattern
of sibling components.

Place design-system styling by ownership: values belonging to a shared primitive
go in the design system config file; layout and genuine one-offs go on the call
site.

## Step 6 — Implement

Write the markup and styles to match the frame exactly:

- Structure: match the Figma layer hierarchy.
- Spacing: use scale utilities or literals; do not approximate. Derive offsets
  from the same box the neighbours use so they stay aligned when it moves.
- Typography: match font family, size, weight, line-height, and letter-spacing.
- Colors: use the mapped token; apply dark mode variants per `darkModeConvention`.
- Images and icons: use `<img alt="…">` or the detected icon library; do not
  inline SVG unless the frame contains a one-off illustration.
- Never colour an icon separately. Set the colour on the parent and let the
  icon inherit `currentColor`, so icon and label stay in sync across states and
  themes.

## Step 7 — Verify interactive states at pointer

At a desktop width, exercise hover, focus, active, and disabled against the
component states you read in Step 2. A page frame instantiates only the Default
state — implementing from it alone will silently ship the UI framework's default
hover instead of the intended one. Check which element is being hovered: hovering
the component directly and hovering its containing card are different tests.

List every interactive state present in Figma but not yet implemented (hover,
focus, active, disabled, loading, error) as owed to `figma-design-check`, not as
omissions to apologize for.

## Step 8 — Verify widths, 320 px included

Check every width the design gives you and the narrowest one it does not. A row
hanging over its gutter fails no test, so add up the row's item widths against
the available width rather than eyeballing the screenshot — a 2 px encroachment
reads as fine and is not. Produce this table before calling a row done:

| Viewport | Available | Content | Headroom | Outcome |
| -------- | --------- | ------- | -------- | ------- |
| 320      |           |         |          |         |
| …frame   |           |         |          |         |

## Traps — what actually costs time

Each is an observed failure pattern, generalized. The bold line is the
principle; apply it to similar cases the list does not name.

- **A layout that fits the designed mobile frame can still fail at 320 px.** The
  narrowest phone is never in the design. Fixed-width or `shrink-0` children that
  total more than the 320 px gutter overflow silently.
- **Count what decoration costs before shrinking content.** Dividers and icons
  consume fixed px. Measure each item before choosing what gives.
- **`flex-wrap` alone breaks in the wrong place.** Wrapping is greedy: the wrap
  point may land mid-decoration. Use `basis-full` to force the break to where you
  intend it.
- **Reach for mobile-first variant pairs, not `max-*` exceptions.** `max-*`
  variants read as exceptions and stack badly against the rest of a mobile-first
  scale.
- **Read the project's breakpoint scale; do not assume Tailwind's defaults.**
  Projects frequently redefine `sm`, `md`, and add sub-mobile breakpoints.
- **A design-system component name is not a library variant name.** Map by actual
  computed values, never by matching names.
- **"No fill" in Figma is not "no fill" in code.** Check what the library's
  variant adds, not only what you add on top.
- **The raw px from `get_design_context` is what Figma stores, not what to
  write.** Convert to the spacing scale.
- **Do not let one element's spacing depend on a sibling that might not render.**
  Feature flags and conditional content collapse gaps. Make designed gaps
  explicit.
- **If the design system has the component, do not hand-roll it.** One component
  with size variants is cheaper than multiple near-copies.
- **`get_metadata` on a large Figma page returns millions of characters.** Dump
  it to a file and grep symbol names rather than reading it inline.
- **You cannot derive a design system library file key from a page file.** Record
  it rather than spending tool calls resolving it.
- **Reuse and verify pull in opposite directions.** Copying a pattern off a
  neighbouring component satisfies reuse while propagating values nobody checked.
  Reuse the structure; confirm the values against the design system.
