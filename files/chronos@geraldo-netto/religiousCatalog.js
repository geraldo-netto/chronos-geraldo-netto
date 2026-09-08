// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

// Translation marker: labels stay stable English msgids in the catalogue and
// are translated only when an observance is expanded for display.
const _ = (text) => text;

// Ordered by number of adherents. The ids identify religions in settings and
// the catalog. Observance rows carry only religious_holiday; their display
// names identify the religion.
var RELIGIONS = [ // NOSONAR [S3504] -- GJS importer export
    { id: "christianity", label: _("Christianity") },
    { id: "islam", label: _("Islam") },
    { id: "hinduism", label: _("Hinduism") },
    { id: "buddhism", label: _("Buddhism") },
    { id: "sikhism", label: _("Sikhism") },
    { id: "judaism", label: _("Judaism") },
    { id: "bahai", label: _("Bahá'í Faith") },
    { id: "jainism", label: _("Jainism") },
    { id: "shinto", label: _("Shinto") },
    { id: "taoism", label: _("Taoism") }
];

for (const religion of RELIGIONS) {
    Object.freeze(religion);
}
Object.freeze(RELIGIONS);

var RELIGION_IDS = Object.freeze( // NOSONAR [S3504] -- GJS importer export
    RELIGIONS.map((religion) => religion.id));

if (typeof module !== "undefined") {
    module.exports = { RELIGIONS, RELIGION_IDS };
}
