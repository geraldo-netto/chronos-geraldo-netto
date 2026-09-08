# Geocoder response contract

Each entry in `GEOCODE_PROVIDERS` supplies `isValidResponse(data)` as well as
`normalize(data, query, hint, canonicalTimezone)` and `url(query, language, hint)`.
The optional hint is either null for a free-text request or
`{timezone, countryCode}` with a canonical named timezone and an uppercase ISO
country code (empty when unavailable). Invalid non-null hints are refused.
Validation returns exactly `true` only for a recognized
successful response. The resolver counts that answer only after normalization
also completes. A missing or throwing hook, malformed response, provider error,
or normalization exception leaves the attempt failed and allows the next provider.

Open-Meteo returns an object with optional `results` and `generationtime_ms`.
Its [documentation](https://open-meteo.com/en/docs/geocoding-api) permits omitted
empty fields. The [controller](https://github.com/open-meteo/geocoding-api/blob/main/Sources/App/GeocodingapiController.swift)
uses [protobuf JSON serialization](https://github.com/open-meteo/geocoding-api/blob/main/Sources/App/Protobuf%2BVapor.swift),
which [omits empty results and zero timing](https://github.com/open-meteo/geocoding-api/blob/main/Sources/App/api.pb.swift#L188-L195).
Consequently `{}`, timing-only objects, and `{"results":[]}` are valid empty
answers. Error objects, unknown envelope fields, malformed timing values, and
non-array `results` are failures. Nominatim's
[search response](https://nominatim.org/release-docs/latest/api/Output/)
must be an array; an empty array is a valid empty answer.

For nonempty results, at least one candidate must have usable coordinates and
valid ranking data. Malformed candidates cannot veto healthy neighbors. Missing
Open-Meteo population is a valid zero-default protobuf field, but remains
untrusted for selection. Validation does not change name ranking or the primary
provider's population refusal: a valid answer can still yield no selected place.

Open-Meteo also [omits zero latitude and longitude](https://github.com/open-meteo/geocoding-api/blob/main/Sources/App/api.pb.swift#L300-L313).
Its candidate decoder therefore supplies zero only when the corresponding field
is absent. Explicit null, undefined, malformed, or out-of-range values remain
invalid. When both coordinates are absent, a nonblank name or positive int32
location ID is required, so empty and unrelated objects cannot become points at
the origin. Validation and selection use the same coordinate decoder; Nominatim
does not inherit these protobuf defaults.

If no provider resolves the location, any valid unresolved answer produces
`LOCATION_NOT_FOUND` and the normal refresh interval applies. If every attempt
fails transport, validation, or normalization, the result is
`SERVICE_UNAVAILABLE` and transient retry remains enabled. Injected providers
use this same required hook; HTTP success or a non-null body alone proves
nothing about response validity.

World-clock requests retain the timezone's city and geographic hint from
`WorldclockData.timezoneWeatherRequest`. GLib validates the identifier, and
`zone.tab` supplies its country before symlink resolution can erase a distinct
location such as Bratislava or Vatican City. Alias rule identities are canonical;
memoized request objects and their hints are frozen. Repeated presenter lookups
use this bounded memo instead of repeating native timezone and file operations.

Open-Meteo's documented [countryCode filter](https://open-meteo.com/en/docs/geocoding-api)
narrows the search. The adapter also verifies the returned country and canonical
timezone, using the resolver-supplied `canonicalTimezone` function to recognize
equivalent aliases. Nominatim's documented
[countrycodes and addressdetails parameters](https://nominatim.org/release-docs/latest/api/Search/)
allow the fallback to verify `address.country_code`. That fallback establishes
country agreement, not timezone agreement. Without a known country, it is
refused because its ordinary search response supplies no timezone.

The query plus hint identifies geocode and reading caches, shared in-flight
requests, per-clock readings and errors, and refresh signatures. A clock's
nickname never enters a request or cache identity. Presenter lookups pass the
clock's timezone so same-name places retain separate readings. Panel free-text
requests stay unhinted and retain the existing name/population ranking and
Nominatim fallback behavior.
