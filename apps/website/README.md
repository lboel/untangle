# @untangle-code/website

Private static landing page for Untangle's local search/complexity harness, without runtime
dependencies. The quickstart installs the published CLI as an exact npm development dependency
and runs a complexity report in the visitor's project. It also shows one-off and global
installation, plus a preview of offline initialization. MCP, indexed search and external
analyzers are optional next steps.

The page distinguishes three layers:

- **Repository complexity:** AST metrics, hotspots, dependencies and call paths for agents.
- **Complexity per feature:** declared Vision/Spec → Feature → Code/Tests → Ownership,
  separate code/test metrics, budgets, shared implementation and missing evidence.
- **Search-based monitoring:** explicitly started Search Journeys with confirmed targets,
  abandoned tasks and caller-declared model/harness/strategy context. Search effort and code
  complexity retain separate meanings.

English product copy describes implemented capabilities. The feature workflow uses existing
manifests, `product --path`, stdout-only `--draft` and explicit source-bound Vitest runs.
Project-specific paths and IDs are replaceable examples. The first setup block runs from an
existing npm project. The one-off command also works from repositories without a package manifest.

The landing-page feature diagram and clear/tangled search comparison are illustrative.
The opening yarn image and scroll-driven 3D scene express the same idea: follow a
responsibility from intent through its implementation, tests and declared ownership.
The four story chapters remain readable without JavaScript. The scene uses local
Canvas geometry, native scrolling and explicit motion controls; it does not run an
analysis, encode real repository metrics or demonstrate autonomous refactoring.
Reduced motion keeps a fixed spatial composition while the explanatory text remains
available. Offscreen/hidden scenes do not run a continuous rendering loop.

The separate **real codebase** example uses Untangle's existing interactive feature-map
renderer with a frozen, source-bound snapshot of Untangle itself. Its complete graph,
feature metrics, missing measurements, unassigned code and evidence limits remain visible.
Ownership remains declared or missing; test evidence marked `not_run` is not represented as passing.
The embedded page is sandboxed with scripts only, loads lazily and has a standalone link.
Its public JSON contains selected relative paths, role labels, measurements and provenance
hashes, without source contents, absolute repository roots, local indexes or raw reports.
Per-symbol hotspot lists, symbol-budget hints and criterion prose are omitted.
Filters, node inspection and camera controls operate on the embedded snapshot; opening
the page does not analyze a repository or contact a service.
The **Untangle by feature** action moves the dense wool layout into declared feature clusters
and back. The separate **Untangle by** selector also offers Code areas, Test areas, Ownership,
Vision / Spec and Unassigned. It is independent of the Layer filter. Code, test and unassigned
areas use file directories; ownership and document context follow declared feature links
without inferring file ownership or specification conformance. Changing the grouping returns
to the tangle without starting motion. Each action changes only the arrangement, preserving
all nodes, relationships, measurements and evidence states. Reduced motion uses fixed endpoints.
The keyboard-native **Groups** disclosure lists complete group names with visible and total
snapshot-node counts. Filters affect visible counts; full feature measurements remain in
the selected node's details.

Measurement and renderer have separate origins: `provenance.revision` identifies the frozen
`d11bdaf` measurement, including its 1,010 source records; `provenance.renderer.revision`
identifies the separately committed renderer. Its five source/Dist records, build-manifest
digests and inline-script/style hashes bind the displayed controls to that renderer build.

Actual project maps are generated separately by `untangle graph features`; they contain
source-bound HTML/JSON under the selected project's `.untangle/feature-map/`. Search patterns
suggest investigation of naming, documentation or feature boundaries without claiming
causal diagnosis. External analyzers remain separately installed/enabled; repository-level
numbers are never relabeled as feature metrics.

## Commands

From the repository root:

```bash
pnpm --filter @untangle-code/website test
pnpm --filter @untangle-code/website check
pnpm --filter @untangle-code/website build
pnpm --filter @untangle-code/website serve
```

`build` copies nine source assets to `dist/` and checks the result. This includes
the exact transparent yarn PNG, the story controller, its local 3D renderer and the frozen
example's standalone HTML and public JSON.
It copies the reviewed snapshot without running an analysis or regenerating data.
Snapshot replacement is an explicit source-bound operation through
[`generate-example.mjs`](scripts/generate-example.mjs); review both output files together.
To render the same frozen measurement with a new verified renderer, use
`--frozen-example=<public-example.json> --renderer-revision=<full-commit>
--renderer-evidence-dir=<build-proof-directory> --out-dir=<new-output-directory>`.
The evidence directory must contain a successful clean-commit `captureGate` build ledger
at `gates/build.json` and its unchanged hash-bound source/Dist manifests and logs. Only
this explicit generation step requires Git history and built renderer modules; source checks
and website tests validate the selected public artifacts without historical checkouts.
`serve` binds to
`127.0.0.1:4173` by default and serves `dist/`; `PORT` chooses another local port and
`--source` uses sources without a preceding build.

## Deliberate boundaries

- No production/runtime dependencies, remote fonts/images, analytics, scripts or automatic
  network requests. The npm package link in the quickstart and GitHub repository link in the
  footer are the only remote URL exceptions. Checks accept their complete fixed HTML
  fragments in their intended positions. Remote resources in HTML, CSS and JavaScript stay blocked.
- The generated example has a separate strict boundary: its approved inline script/style
  bytes are hash-bound, its Content Security Policy denies network access, and the SVG
  namespace is accepted only as a namespace. Public projection validation checks the JSON
  and decoded embedded graph. The example does not relax the landing page's resource or
  design constraints.
- Both Search Journey routes remain readable without JavaScript. Tabs enhance the view;
  code blocks remain keyboard-focusable and horizontally scrollable.
- Copy controls require the Clipboard API. Pending access disables the button; success and
  blocked access are announced through a live region. Commands remain selectable for manual
  copying if the API is absent or denied.
- Navigation/buttons/disclosures have at least 44 CSS-pixel target height. Focus and
  reduced-motion rules remain.
- Feature IDs and free-form Journey context use local HMAC fingerprints by default; text
  retention is explicit.
- Landing HTML/CSS use OKLCH tokens and the established light paper/teal/orange identity.
  Transparent wool-ball SVG and favicon use renderer-compatible sRGB colors. The yarn PNG is copied
  byte-for-byte from [the canonical brand asset](../../docs/assets/untangle-yarn-3d.png),
  retaining its native alpha and embedded generation prompt.
- Offline initialization is previewed with `--dry-run` before the apply command. Feature assignment,
  services and test execution are not represented as automatically complete. Deterministic
  offline vectors are separate from language-model semantics.

Source checks and interaction tests do not replace actual desktop/mobile rendering,
keyboard or screen-reader acceptance. Prior local-file preview was blocked by browser
policy; no alternate access path was used to bypass it. Record permitted browser evidence
before claiming visual/accessibility acceptance of a release.

The app belongs to pnpm/Vitest through `apps/*`. The separate
[Pages workflow](../../.github/workflows/pages.yml) publishes only its eleven-file allowlist:
the nine website assets plus the package's complete `LICENSE` and `NOTICE`.
See [website deployment](../../docs/WEBSITE_DEPLOYMENT.md)
for the source-bound publication and verification procedure.
