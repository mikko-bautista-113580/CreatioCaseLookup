# Case knowledge index

The creatio-case-fix skill's own memory. It reads these notes in Step 1b and
writes to them in Step 7. One note per learning, in `<kebab-slug>.md`, with
frontmatter `name`, `description`, `type` (`district` | `pattern` |
`resolution` | `gotcha`), `tags`, `cases`, `updated`.

Notes are leads to check against the current code, not proof. They hold only
technical learnings: no names, emails, credentials or verbatim client text.

One line per note: `- [name](file.md) — hook · tags`

- [logo-asset-naming](logo-asset-naming.md) — how to add a client's new report logo without breaking the old one · logo, report-card, img, attachment
