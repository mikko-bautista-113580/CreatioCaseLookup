---
name: logo-asset-naming
description: A new report logo is added beside the old one as <stem>-SRxxxxxxxx.<ext>, and only the img src filename changes
type: pattern
tags: [logo, report-card, img, attachment]
cases: [SR00064810]
updated: 2026-09-25
---

When a case asks for a new logo, save the attachment next to the existing one as
`<existing stem>-<SR number>.<real extension>`, e.g. `EP-JAM-Logo.jpg` →
`EP-JAM-Logo-SR00064810.jpg`. Then change only the filename at the end of the
template's `<img src="https://#dsn#.client.renweb.com/renweb/Reports/ReportCard/<district>/...">`.
Leave `#dsn#`, the host, the path and `width`/`height` exactly as they are.

**Why:** Other schools, terms or archived reports may still point at the old
file. The `src` is an absolute RenWeb URL, so the new file only shows up after
someone deploys it to that server path.

**How to apply:** Mark the logo ask **partial** until it has been deployed. Never
use `--overwrite` on the `attachment` command. Take colours from the case text,
never from the image.
