# ASCII-art PowerShell CLI benchmark

This controlled benchmark tested whether a GPT-5.6 Sol parent should delegate one
small ASCII banner to a Claude Haiku 4.5 worker while retaining feature implementation
and testing.

- [`protocol.md`](protocol.md) is the concise methodology.
- [`report.md`](report.md) is the canonical result.
- [`prompts.json`](prompts.json), [`design/`](design/), [`fixture/`](fixture/),
  [`acceptance/`](acceptance/), and [`rubric.md`](rubric.md) retain the frozen task,
  schedule, executable fixture, external deterministic checks, and blind rubric.

The run produced 46 selected observations and 20 complete treatment/control pairs
from 60 planned schedules. Treatment was 54.9% faster, but used 69.7% more combined
AI credits and 53.9% more parent cumulative input, with lower deterministic and
blinded quality. Fourteen schedules were missing, so inference is withheld.

Raw event streams, runtime payloads, copied artifacts, per-run judgments, and generated
summaries were removed from the working tree. Their immutable history remains under the
original experiment commits and tags cited in the report.
