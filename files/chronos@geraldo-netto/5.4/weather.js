/* global imports */

const WeatherModule = imports.ui.appletManager.applets["chronos@geraldo-netto"].weather;

if (typeof module !== "undefined") {
    module.exports = WeatherModule;
}
