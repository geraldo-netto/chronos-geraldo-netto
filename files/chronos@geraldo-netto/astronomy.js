// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Offline, low-precision solar and lunar rise/set calculations. This module has
// no platform or network dependency: callers provide one local civil day's UTC
// bounds and the observer coordinates already resolved by the weather feature.

var ASTRONOMY_DAY_MS = 86400000; // NOSONAR [S3504] -- GJS importer export
var ASTRONOMY_MAX_DAY_MS = 26 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export
var ASTRONOMY_SAMPLE_MS = 20 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export

const RAD = Math.PI / 180;
const JULIAN_1970 = 2440588;
const JULIAN_2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const SUN_RISE_ALTITUDE = RAD * -0.833;
const MOON_RISE_ALTITUDE = RAD * 0.133;
const CROSSING_REFINEMENTS = 12;
const EXTREME_REFINEMENTS = 16;

function validCoordinates(latitude, longitude) {
    return typeof latitude === "number" && Number.isFinite(latitude) &&
        latitude >= -90 && latitude <= 90 &&
        typeof longitude === "number" && Number.isFinite(longitude) &&
        longitude >= -180 && longitude <= 180;
}

function validDayBounds(startMs, endMs) {
    const span = endMs - startMs;
    return Number.isFinite(startMs) && Number.isFinite(endMs) &&
        span > 0 && span <= ASTRONOMY_MAX_DAY_MS;
}

function julianDays(timestamp) {
    return timestamp / ASTRONOMY_DAY_MS - 0.5 + JULIAN_1970 - JULIAN_2000;
}

function rightAscension(longitude, latitude) {
    return Math.atan2(
        Math.sin(longitude) * Math.cos(OBLIQUITY) -
            Math.tan(latitude) * Math.sin(OBLIQUITY),
        Math.cos(longitude));
}

function declination(longitude, latitude) {
    return Math.asin(
        Math.sin(latitude) * Math.cos(OBLIQUITY) +
            Math.cos(latitude) * Math.sin(OBLIQUITY) * Math.sin(longitude));
}

function altitude(hourAngle, latitude, bodyDeclination) {
    return Math.asin(
        Math.sin(latitude) * Math.sin(bodyDeclination) +
            Math.cos(latitude) * Math.cos(bodyDeclination) * Math.cos(hourAngle));
}

function siderealTime(days, westLongitude) {
    return RAD * (280.16 + 360.9856235 * days) - westLongitude;
}

function solarMeanAnomaly(days) {
    return RAD * (357.5291 + 0.98560028 * days);
}

function solarEclipticLongitude(meanAnomaly) {
    const equationOfCenter = RAD * (1.9148 * Math.sin(meanAnomaly) +
        0.02 * Math.sin(2 * meanAnomaly) +
        0.0003 * Math.sin(3 * meanAnomaly));
    return meanAnomaly + equationOfCenter + RAD * 102.9372 + Math.PI;
}

function sunCoordinates(days) {
    const longitude = solarEclipticLongitude(solarMeanAnomaly(days));
    return {
        rightAscension: rightAscension(longitude, 0),
        declination: declination(longitude, 0)
    };
}

function moonCoordinates(days) {
    const meanLongitude = RAD * (218.316 + 13.176396 * days);
    const meanAnomaly = RAD * (134.963 + 13.064993 * days);
    const meanDistance = RAD * (93.272 + 13.229350 * days);
    const longitude = meanLongitude + RAD * 6.289 * Math.sin(meanAnomaly);
    const latitude = RAD * 5.128 * Math.sin(meanDistance);
    return {
        rightAscension: rightAscension(longitude, latitude),
        declination: declination(longitude, latitude)
    };
}

function bodyAltitude(timestamp, latitude, longitude, coordinateFunction) {
    const days = julianDays(timestamp);
    const coordinates = coordinateFunction(days);
    const westLongitude = -longitude * RAD;
    const hourAngle = siderealTime(days, westLongitude) - coordinates.rightAscension;
    return altitude(hourAngle, latitude * RAD, coordinates.declination);
}

function sunAltitude(timestamp, latitude, longitude) {
    return bodyAltitude(timestamp, latitude, longitude, sunCoordinates);
}

function moonAltitude(timestamp, latitude, longitude) {
    return bodyAltitude(timestamp, latitude, longitude, moonCoordinates);
}

function crossingDirection(leftOffset, rightOffset) {
    if (leftOffset < 0 && rightOffset >= 0) {
        return "rise";
    }
    if (leftOffset > 0 && rightOffset <= 0) {
        return "set";
    }
    return "";
}

function altitudeOffset(timestamp, altitudeFunction, observer) {
    return altitudeFunction(timestamp, observer.latitude, observer.longitude) -
        observer.threshold;
}

function refineCrossing(leftMs, rightMs, leftOffset, altitudeFunction,
    latitude, longitude, threshold) {
    let lower = leftMs;
    let upper = rightMs;
    let lowerOffset = leftOffset;

    for (let attempt = 0; attempt < CROSSING_REFINEMENTS; attempt++) {
        const middle = (lower + upper) / 2;
        const middleOffset = altitudeFunction(middle, latitude, longitude) - threshold;
        if ((lowerOffset < 0) === (middleOffset < 0)) {
            lower = middle;
            lowerOffset = middleOffset;
        } else {
            upper = middle;
        }
    }

    return Math.round((lower + upper) / 2);
}

function extremeDirection(leftOffset, rightOffset) {
    if (leftOffset < 0 && rightOffset < 0) {
        return 1;
    }
    if (leftOffset > 0 && rightOffset > 0) {
        return -1;
    }
    return 0;
}

function refineExtreme(leftMs, rightMs, altitudeFunction, observer, direction) {
    let lower = leftMs;
    let upper = rightMs;
    for (let attempt = 0; attempt < EXTREME_REFINEMENTS; attempt++) {
        const third = (upper - lower) / 3;
        const first = lower + third;
        const second = upper - third;
        const firstOffset = altitudeOffset(first, altitudeFunction, observer);
        const secondOffset = altitudeOffset(second, altitudeFunction, observer);
        if (direction * firstOffset < direction * secondOffset) {
            lower = first;
        } else {
            upper = second;
        }
    }
    const timestamp = (lower + upper) / 2;
    return {
        timestamp,
        offset: altitudeOffset(timestamp, altitudeFunction, observer)
    };
}

function hiddenExtreme(leftMs, rightMs, leftOffset, rightOffset,
    altitudeFunction, observer) {
    const direction = extremeDirection(leftOffset, rightOffset);
    if (!direction) {
        return null;
    }
    const point = refineExtreme(leftMs, rightMs, altitudeFunction, observer, direction);
    return direction * point.offset >= 0 ? point : null;
}

function horizonState(rise, set, minimum, maximum) {
    if (rise !== null || set !== null) {
        return "normal";
    }
    if (minimum > 0) {
        return "alwaysUp";
    }
    if (maximum < 0) {
        return "alwaysDown";
    }
    return "normal";
}

function recordCrossing(events, direction, timestamp) {
    if (direction === "rise" && events.rise === null) {
        events.rise = timestamp;
    } else if (direction === "set" && events.set === null) {
        events.set = timestamp;
    }
}

function altitudeEvents(startMs, endMs, latitude, longitude,
    altitudeFunction, threshold) {
    const observer = Object.freeze({latitude, longitude, threshold});
    let leftMs = startMs;
    let leftOffset = altitudeOffset(leftMs, altitudeFunction, observer);
    let minimum = leftOffset;
    let maximum = leftOffset;
    const events = { rise: null, set: null };

    while (leftMs < endMs) {
        const rightMs = Math.min(leftMs + ASTRONOMY_SAMPLE_MS, endMs);
        const rightOffset = altitudeOffset(rightMs, altitudeFunction, observer);
        const interior = hiddenExtreme(leftMs, rightMs, leftOffset, rightOffset,
            altitudeFunction, observer);
        const samples = interior ? [interior, { timestamp: rightMs, offset: rightOffset }] :
            [{ timestamp: rightMs, offset: rightOffset }];
        for (const sample of samples) {
            const direction = crossingDirection(leftOffset, sample.offset);
            if (direction) {
                recordCrossing(events, direction, refineCrossing(
                    leftMs, sample.timestamp, leftOffset, altitudeFunction,
                    latitude, longitude, threshold));
            }
            minimum = Math.min(minimum, sample.offset);
            maximum = Math.max(maximum, sample.offset);
            leftMs = sample.timestamp;
            leftOffset = sample.offset;
        }
    }

    events.state = horizonState(events.rise, events.set, minimum, maximum);
    return events;
}

function calculateAstronomyEvents(startMs, endMs, latitude, longitude) {
    if (!validDayBounds(startMs, endMs) || !validCoordinates(latitude, longitude)) {
        return null;
    }

    return {
        sun: altitudeEvents(startMs, endMs, latitude, longitude,
            sunAltitude, SUN_RISE_ALTITUDE),
        moon: altitudeEvents(startMs, endMs, latitude, longitude,
            moonAltitude, MOON_RISE_ALTITUDE)
    };
}

if (typeof module !== "undefined") {
    module.exports = {
        ASTRONOMY_DAY_MS,
        ASTRONOMY_MAX_DAY_MS,
        ASTRONOMY_SAMPLE_MS,
        validCoordinates,
        validDayBounds,
        julianDays,
        rightAscension,
        declination,
        altitude,
        siderealTime,
        solarMeanAnomaly,
        solarEclipticLongitude,
        sunCoordinates,
        moonCoordinates,
        bodyAltitude,
        sunAltitude,
        moonAltitude,
        crossingDirection,
        refineCrossing,
        extremeDirection,
        refineExtreme,
        hiddenExtreme,
        horizonState,
        recordCrossing,
        altitudeEvents,
        calculateAstronomyEvents
    };
}
