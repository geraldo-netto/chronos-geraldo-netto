// A fixed clock for the suites that read "now" through production code.
//
// The holiday cache windows the years it keeps around the current one, and its
// staleness rule is `Date.now() - retrieved < UPDATE_PERIOD` — so tests reached
// for `new Date().getFullYear()` to say what the code would be looking at, and
// several recomputed it *inside the assertion*. A run that straddles midnight on
// New Year's Eve then compares one year against the other and fails, and a run at
// any other moment cannot tell you it would have.
//
// Nothing here mocks time passing: it only stops the wall clock. Tests that need
// two instants inject their own `now` (the repository and the cache both take
// one) or move FixedDate's instant with `at()`.
const REAL_DATE = Date;

// 2026-07-15T12:00:00Z. Midday, mid-month, mid-year: no day, month or year
// boundary is within hours of it, so nothing rolls over underneath a test. It is
// also after the suites' Date-header fixtures (8–10 July) — the cache refuses a
// stamp from the future, and a stamp is only "the future" relative to now.
const FIXED_NOW = REAL_DATE.UTC(2026, 6, 15, 12, 0, 0);

function makeFixedDate(now) {
    return class FixedDate extends REAL_DATE {
        constructor(...args) {
            if (args.length === 0) {
                super(now);
                return;
            }

            super(...args);
        }

        static now() {
            return now;
        }
    };
}

// Freeze `new Date()` and `Date.now()` for the caller. Returns the restore
// function; every explicit `new Date(2026, …)` keeps working untouched.
function freezeClock(now = FIXED_NOW) {
    const previous = globalThis.Date;
    globalThis.Date = makeFixedDate(now);
    return () => {
        globalThis.Date = previous;
    };
}

module.exports = {
    FIXED_NOW,
    FIXED_YEAR: new REAL_DATE(FIXED_NOW).getUTCFullYear(),
    freezeClock
};
