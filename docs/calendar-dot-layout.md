# Calendar dot layout

The allocation callback schedules a calendar render only when a cell's dot
capacity changes. Capacity is an integer from 1 to 64; an empty box reports
zero and leaves the last usable capacity intact. The calendar replaces its
pending idle when several cells change, leaving one render scheduled.

This behavior was exercised in an isolated Cinnamon 6.6.9 / CJS 115.1 session
at 1366×768, with private XDG directories, a private D-Bus session and Xvfb.
All 42 real calendar cells received synthetic event colors. The live theme
used 12×4px dots and one or two rows. Render calls, allocation calls, capacity
notifications and the pending render source were counted inside Cinnamon.

`Cinnamon.GenericContainer` normally requests zero natural width for this dot
box, independently of its children. To test the stronger case where adding
dots enlarges the box, each live box also received this preferred-width
handler. Its maximum was varied without replacing the real allocation code:

```js
cell.dot_box.connect('get-preferred-width', (actor, height, allocation) => {
    const width = actor.get_children().reduce((total, dot) =>
        total + dot.get_preferred_width(-1)[1], 0);
    allocation.min_size = Math.min(width, maximumWidth);
    allocation.natural_size = allocation.min_size;
});
```

The surrounding day cell retained a minimum effective width of 33px. Each
scenario was sampled every 150ms for 1.8 seconds; the final samples showed
unchanged render/allocation counters and no pending calendar render.

| Change | Width limit | Events per day | Rows | Visible dots | Calendar renders, including requested update |
| --- | --- | --- | --- | --- | --- |
| Dense day | 48px | 512 | 2 | 8 | 2 |
| Narrower content | 12px | 512 | 2 | 4 | 2 |
| Expanded content | 120px | 512 | 2 | 20 | 4 |
| Sparse day | 120px | 2 | 2 | 2 | 2 |
| Empty day | 120px | 0 | 2 | 0 | 1 |
| Refilled day | 120px | 512 | 2 | 20 | 4 |
| One-row theme | 48px | 512 | 1 | 4 | 2 |
| Two-row theme | 48px | 512 | 2 | 8 | 2 |

Expansion and refill followed 4 → 8 → 16 → 20 dots, with allocated widths
48 → 96 → 120px. The three rounds of 42 capacity notifications produced
three additional renders. No oscillation occurred. The ordinary calendar
regression suite now repeats these dimensions and transitions and verifies
that unchanged allocations leave no render scheduled. The live result covers
ordinary monotonic content sizing; a theme or extension that changes geometry
according to unrelated state must be evaluated separately.
