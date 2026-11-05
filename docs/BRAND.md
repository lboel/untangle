# Untangle brand assets

Untangle traces a responsibility through a codebase: find the implementation,
connect it to its declared feature, and keep its complexity visible as the product
changes. A woven ball with one free thread is the visual expression of that idea.

## Assets

| Asset | Use |
|---|---|
| [Color mark](./assets/untangle-mark.svg) | Light backgrounds, README fallback and website identity. |
| [Dark-background mark](./assets/untangle-mark-dark.svg) | Light ink and a copper thread on dark backgrounds. |
| [Monochrome mark](./assets/untangle-mark-mono.svg) | One-ink uses; inherits `currentColor` when inlined. |
| [3D yarn illustration](./assets/untangle-yarn-3d.png) | README or editorial illustration, with native transparency. |
| [Illustration generation prompt](./assets/untangle-yarn-3d.prompt.txt) | Exact creative brief, also embedded in the PNG metadata. |

The mark uses authored SVG geometry with transparent crossings, without scripts,
external fonts or linked resources. The website's `untangle-logo.svg` is a copy of
the color mark. Preserve the supplied viewBox and aspect ratio. Leave clear space
around the entire mark, including its loose thread, and use the monochrome version
where color reproduction is limited. An externally embedded monochrome SVG uses
the image's own default ink; a surrounding page's text color is inherited only
when the SVG is inlined.

The README selects its dark-background mark through GitHub's supported
[`picture` and `prefers-color-scheme` pattern](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github).
The default color image remains available to other Markdown viewers.

## Color and material

| Color | Value | Role |
|---|---|---|
| Forest | `#003632` | The woven responsibility and existing product identity. |
| Copper | `#dd6221` | The free thread and an intentional point of emphasis. |
| Paper | `#f8f5ed` | The established website surface and light ink on dark backgrounds. |

Use the appropriate asset for its ground. Keep the brand mark separate from
interactive controls and data encoding. Decorative color does not communicate
measurement status, ownership approval or test success.

## Illustration provenance

The 1774 × 887 PNG was generated with the built-in Imagegen tool on 2026-11-03
from the committed prompt. Its native alpha channel is retained. Only prompt
metadata was added; the compressed pixel data is unchanged from the generated
original. No source photograph, third-party logo or reference artwork was used.

This is a **brand illustration**, not a screenshot, live graph or measured result.
Its weave and lighting express the product's idea; they encode no repository data.
The README labels the illustration accordingly.

The landing page uses the same PNG in its opening and as the fallback for a
scroll-driven 3D scene. The scene follows four steps: declared intent, local
search, complete feature responsibility and a bounded change. Its spatial yarn
geometry and relationships are illustrative, not discovered repository data.
Visitors can rotate the scene or pause motion. Reduced-motion preferences keep a
fixed composition, and all explanatory content remains readable without scripts.

The interactive feature map is a separate product capability. Generate it from a
repository with `untangle graph features`; its HTML and JSON live under that
repository's `.untangle/feature-map/`. Its actual declarations, source evidence and
coverage determine the result. See [feature alignment](./FEATURE_ALIGNMENT.md).

The landing page also embeds a frozen map of Untangle itself at `d11bdaf`.
This uses the product's actual 3D viewer with measured feature scopes and declared
relationships. Its publication projection retains relative paths, metrics,
coverage and provenance while excluding source text and machine-local paths.
The full graph includes violations, missing measurements and unassigned code;
declared roles and absent test-run evidence remain explicit. It is separate
from the illustrative yarn story above it.

The viewer's **Untangle by feature** action animates the same nodes and edges into
groups based on direct, typed feature-scope declarations. Shared context and
unassigned nodes retain separate groups. It changes layout and thread routing,
not code, measurements, evidence status or ownership. Motion starts on request,
supports pause, resume and reverse replay, and groups instantly with reduced
motion. The frozen measurements and the newer renderer have separate provenance.

The **Untangle by** selector also exposes code areas, test areas, ownership,
Vision / Spec and unassigned files. Directory grouping is structural. Owner and
document grouping presents declared context through features, not inferred
responsibility or semantic conformance. Every category retains shared and absent
context, and its animation starts only on request.

## License

The repository's [AGPL-3.0-only license](../LICENSE) and [NOTICE](../NOTICE) apply to
the first-party branding materials distributed here as well as the source code
and documentation. This is not a separate trademark permission. Third-party
materials retain their own notices; see [licensing scope](./LICENSING.md).
