# Native popup verification

The popup was exercised in Cinnamon 6.6.9 / CJS 115.1 with the
Mint-Y-Dark-Aqua theme on a 1366×768 virtual X11 display. These are measurements
from real St actors after allocation, with screenshots inspected; the Node
layout tests separately cover arithmetic and recovery paths.

The session used private XDG configuration, data, cache, runtime, and D-Bus
state. Xsettings ran in that same session with the keyfile GSettings backend.
Display scale was set at process startup with `GDK_SCALE`, and verified against
`global.ui_scale`; text scale came from the desktop interface settings. No
personal settings or installed applets were changed. See
[native imports](native-imports.md) for the isolated runtime prerequisites.

## Rendered matrix

Sizes and positions below are physical pixels, rounded from native transforms.
Each combination was checked with German and Russian date, month, and settings
label fixtures. Examples include `Donnerstag, 24. September 2026` and
`четверг, 24 сентября 2026 г.`. Fixtures exercise text width and glyph rendering;
they do not change gettext catalog selection or saved translations.

| Display / text scale | Panel | Layout | Popup size, German / Russian | Popup position, German / Russian |
| --- | --- | --- | --- | --- |
| 1 / 1 | Bottom | Horizontal | 650×468 / 647×468 | (716,260) / (719,260) |
| 1 / 1 | Left | Horizontal | 650×468 / 647×468 | (81,300) / (81,300) |
| 2 / 1.5 | Bottom | Stacked | 1170×618 / 1170×618 | (196,70) / (196,70) |
| 2 / 1.5 | Left | Stacked | 1016×690 / 1016×690 | (236,78) / (236,78) |

Every popup fits the visible work area. At display scale 2, the bottom panel
leaves 1366×688 pixels and the left panel leaves 1286×768. The side-panel clock
label extends to x=236, so Cinnamon's popup anchor leaves 1130 pixels to its
right; the width budget also accounts for that anchor.

In the large-text stack, the agenda measured 404 pixels high, exceeding its
360-pixel floor (`120 × 2 × 1.5`). The gap between agenda and calendar measured
20 pixels. Reflow preserved agenda-before-calendar actor order. The body can
scroll on either axis; the settings entry remains outside that viewport and
visible. Long issue messages wrap inside the body.

## Keyboard and scrolling

Real XTest key events verified that opening the menu focuses the selected day,
PageDown advances one month, and Home returns to today. Tab reaches the settings
entry and the month/year navigation controls. Focus changes reveal the relevant
calendar control in the outer viewport.

Three real EventRow actors, populated with local EventData fixtures and an
inert launcher, exercised nested agenda scrolling. Focusing the third row moved
the agenda adjustment to 246 pixels and the outer adjustment to about 234.
Its vertical extent was 119–267, within both the agenda clip (-23–267) and the
outer viewport (118–616). The complete focused row was visible. The fixture
included both German and Russian event summaries.

For a repeat check, open the menu in an isolated session at each scale and
panel orientation, allow allocation to settle, and inspect these objects using
Cinnamon's Eval interface:

```javascript
const applet = imports.ui.appletManager.get_object_for_uuid(
    'chronos@geraldo-netto', 'chronos@geraldo-netto');
applet._menuLayoutEnvironment();
applet.menu.actor.get_transformed_position();
applet.menu.actor.get_transformed_size();
applet._menuLayout._viewport.actor.get_transformed_size();
global.stage.get_key_focus().get_transformed_position();
```

Check the focused actor against every enclosing scroll viewport, as well as the
screen bounds. A row inside the outer viewport can still be clipped by the
agenda's inner viewport. Capture screenshots after allocation, and inspect the
Cinnamon log for applet exceptions and CSS parser criticals; none occurred in
the verified matrix. Repeat these checks when changing layout, focus handling,
or the deployed theme.
