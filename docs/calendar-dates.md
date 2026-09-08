# Calendar dates and local time

The month grid contains 42 consecutive Gregorian dates. Its day labels,
weekday columns, week numbers, and holiday keys come from civil year/month/day
values, independently of the local timezone's clock changes.

Each cell has a separate local event projection. A repeated midnight uses
its earliest occurrence, so both copies of that date's events share one day
key. A whole date omitted by a timezone change, such as December 30, 2011 in
Pacific/Apia, has no local event projection. Its label and holiday annotation
remain visible, it displays no event dots, and clicking it leaves the selection
unchanged. Arrow navigation crosses such a date in the requested direction.

Month browsing uses Gregorian month lengths. If its target date was omitted
locally, it selects the adjacent representable date within the target month.
The local-date lookup makes at most two attempts; failed projections leave
the selection unchanged.

Event-fetch bounds derive from the same 42-date window. Each endpoint is
projected independently: an omitted first date cannot shift the exclusive end
forward. Calendar selection is passed to the surrounding applet as a local
JavaScript `Date`.
