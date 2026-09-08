# Weather reading temperatures

Provider readings contain Celsius numbers that must remain finite in both SI
and imperial display units. `weatherFormat.validTemperature` owns this rule.
The built-in adapters and forecast resolver apply it before a reading can be
accepted or cached, including readings returned by injected forecast providers.
METAR applies it before station ranking so an unusable nearby temperature cannot
displace a valid neighboring station. Numeric METAR temperature strings are
parsed before this check.

Fahrenheit conversion uses `celsius * 1.8 + 32`, avoiding overflow from the
intermediate multiplication by nine. For example, `2e307` Celsius remains
displayable as `3.6e307` Fahrenheit. A value such as `Number.MAX_VALUE` is refused
even while SI is selected because a later unit switch would overflow. The bound
is floating-point representability in both supported units.

Refused readings follow the existing provider fallback and retry paths. A failed
refresh preserves the last good reading under the usual freshness policy.
Direct calls to `formatTemperature` with malformed or unrepresentable input
return empty text rather than rendering `NaN` or `Infinity`.
