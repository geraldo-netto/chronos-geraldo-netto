# UI And UX

Use this module for user-facing interfaces, dashboards, operator tools, Streamlit apps, and React apps.

## Product Experience

- Build the actual usable experience first, not a marketing shell, unless the task is explicitly a landing page.
- Tailor density, visual tone, and workflows to the product category.
- Operational tools should be quiet, scannable, predictable, and efficient.
- Games and playful experiences may be more expressive, animated, and illustrative.
- Common workflows should be ergonomic from first load through completion, including returning to prior views.

## States

Every user-facing flow should handle:

- loading
- empty
- partial success
- validation failure
- recoverable error
- unrecoverable error
- permission/auth failure where applicable

Error messages should say what failed, why when known, and what the user can do next.

## Accessibility

- Do not rely on color alone to communicate state.
- Provide sufficient contrast.
- Use semantic HTML where possible.
- Add ARIA only where native semantics are insufficient.
- Ensure modals, command palettes, drag/drop controls, and custom widgets support keyboard navigation and focus management.
- Preserve visible focus states.
- Check mobile and small-screen behavior for critical flows.

## Design Rules

- Keep text readable and within its container at mobile and desktop sizes.
- Avoid overlap between text, controls, cards, and media.
- Use stable dimensions for boards, grids, toolbars, counters, and tiles so dynamic content does not shift layout unexpectedly.
- Do not scale font size directly with viewport width.
- Keep letter spacing at `0` unless an existing design system requires otherwise.
- Avoid one-note palettes dominated by one hue family.
- Do not put cards inside cards.
- Use cards for repeated items, modals, and genuinely framed tools; use full-width bands or unframed layouts for page sections.
- Cards should generally have border radius of 8px or less unless the design system says otherwise.

## Controls

- Use familiar controls for familiar jobs:
  - icons for tool buttons
  - swatches for color
  - segmented controls for modes
  - toggles or checkboxes for binary settings
  - sliders, steppers, or inputs for numeric values
  - menus for option sets
  - tabs for views
- Use text or icon+text buttons for clear commands.
- Prefer existing icon libraries, such as lucide in React apps, over custom SVG icons.
- Provide tooltips for unfamiliar icons.
- Do not add visible in-app text that explains obvious implementation details, keyboard shortcuts, or visual styling unless the product needs that help.

## Security And Content Safety

- Escape or sanitize rendered content from user input, retrieved documents, logs, or indexed passages.
- Route i18n strings through the project catalog when one exists.
- Avoid hard-coded English in localized apps.

## i18n

- Do not hardcode product text in UI components when localization is in scope.
- Route labels, buttons, menus, placeholders, tooltips, errors, success messages, job statuses, empty states, dialogs, notifications, and backend messages shown in the UI through the locale catalog.
- Technical strings may remain literal when they are ids, enum values, table names, routes, event names, or protocol constants.

## Verification

- Check desktop and mobile layouts.
- Verify that all expected visual assets render.
- Verify that empty, loading, and error states are reachable.
- For canvas or 3D scenes, verify the canvas is nonblank, framed correctly, and interactive or animated as intended.
