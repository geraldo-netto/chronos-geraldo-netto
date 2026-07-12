# Product Strategy And Discovery

Use this module when evaluating product direction, backlog quality, prioritization, or user-facing scope.

## Product Engineering

- Shipped defaults should match documented defaults.
- Setup, onboarding, and first-run failures should have clear remediation.
- Runtime failures should be actionable.
- Docs and UI should use the same names for the same concepts.
- Feature pairs should compose end to end; a flag with no enforcement or an API with no UI is a finding.

## Design Thinking

- Ground user-facing decisions in observed needs and framed problems.
- Use the canonical loop when useful: empathize, define, ideate, prototype, test.
- Distinguish desirability, feasibility, and viability.
- Use empathy maps, lightweight personas, journey maps, POV statements, and How-Might-We framing when the problem is unclear.

## Product Refinement

- Assess whether the product that exists is coherent and complete within its declared scope.
- Use story mapping to walk core journeys end to end.
- Apply the walking-skeleton test: every shipped capability should be reachable at some minimal depth before any one capability gets deep.
- Use MoSCoW or Kano to prioritize must-have slice gaps before polish.
- Record dogfooding friction as first-class refinement input.

## Jobs To Be Done

- Every shipped capability should trace to a concrete job: when the user is in a situation, what progress do they seek, and what outcome tells them it worked.
- Map core jobs into steps and identify broken or missing steps.
- Do not measure success only by feature usage; measure job completion or task success when possible.

## Product-Market Fit And Strategy

- Define target user, underserved need, value proposition, feature set, and UX assumptions.
- Validate with privacy-respecting methods: opt-in surveys, interviews, beta cohorts, public feedback channels, or smoke tests.
- Useful lenses include Sean Ellis PMF survey, Dan Olsen PMF Pyramid, Value Proposition Canvas, Business Model Canvas, Kano, April Dunford positioning, Crossing the Chasm, AARRR, North Star Metric, RICE/ICE, and Lean Startup Build-Measure-Learn.
- A strategy should include diagnosis, guiding policy, and coherent actions, not only a feature list.
- Useful strategy lenses include Rumelt's kernel, Playing to Win, Wardley Mapping, Blue Ocean/ERRC, and Three Horizons.

## Prioritization And Governance

- Use an explicit prioritization model such as WSJF, Cost of Delay, RICE, ICE, MoSCoW, Kano, or Eisenhower.
- Record decision owners, decide-by dates, risks, assumptions, issues, and dependencies when cross-cutting work can stall.
- Useful governance tools include RAID logs, DACI/RACI, Definition of Ready/Done, Now-Next-Later, and GIST.
- Privacy stance applies to analytics: no default-path telemetry unless the product explicitly allows it.
