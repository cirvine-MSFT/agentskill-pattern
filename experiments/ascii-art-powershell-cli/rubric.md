# Blinded quality rubric

Judge only the anonymized artifact bundle. Do not infer condition, agent use, model routing, cost, or process. Judge usage is not part of benchmark efficiency.

Score each dimension from 1 to 5 using the anchors below. Return one integer per dimension, a brief evidence-based rationale, and an overall score equal to the arithmetic mean rounded to two decimals. A deterministic failure informs function and integration but does not force unrelated art scores to 1.

| Score | Anchor |
|---:|---|
| 1 | Broken, absent, misleading, or substantially harmful. |
| 2 | Major defects; only a limited portion is usable. |
| 3 | Adequate and mostly correct, with material gaps or rough edges. |
| 4 | Strong, correct, coherent work with only minor issues. |
| 5 | Exceptional completeness, clarity, polish, and task fit. |

## Dimensions

1. **Function:** Required behavior works, handles specified normal/error cases, and preserves existing behavior.
2. **Code quality:** Implementation is clear, idiomatic PowerShell, appropriately factored, and robust without needless complexity.
3. **Integration:** Feature fits the existing CLI, persistence model, help/output conventions, and tests; the banner is used where requested rather than merely present.
4. **Recognizability:** The banner visibly represents the requested subject and required literal at ordinary terminal size.
5. **Composition:** The banner has deliberate hierarchy, spacing, proportions, and legibility within its fixed dimensions.
6. **Cleanliness:** Diff is focused; no generated clutter, acceptance tampering, irrelevant changes, trailing whitespace, or accidental artifacts.

Do not reward scope beyond the prompt. Penalize unnecessary rewrites, test weakening, hidden dependencies, brittle environment assumptions, or banner content that meets characters mechanically but is not visually meaningful.
