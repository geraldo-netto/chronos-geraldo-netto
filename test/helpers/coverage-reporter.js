"use strict";

// A test reporter that writes the coverage summary as JSON, so the per-file gate
// in coverage.js can read the same numbers node computed rather than scraping
// the printed table.

module.exports = async function* coverageReporter(source) {
    let summary = null;

    for await (const event of source) {
        if (event.type === "test:coverage") {
            summary = event.data.summary;
        }
    }

    yield JSON.stringify(summary, null, 2);
};
