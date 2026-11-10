# Publish the website with GitHub Pages

The website has its own deployment boundary. The Untangle repository can remain
**private** while the selected static website is public. Publishing the website
does not publish npm packages, change repository visibility or mark a release
candidate verified.

## Account and repository prerequisites

GitHub Pages from a private repository requires an eligible GitHub Pro, Team or
Enterprise plan. The authenticated maintainer must also have permission to manage
Pages. See [GitHub Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
An absent `plan` field in API metadata is not proof of eligibility or ineligibility.

Configure this repository's Pages build source as **GitHub Actions**. This is a
separate administration step; the workflow does not create a site, purchase an
account upgrade or change visibility. With an authorized maintainer's GitHub CLI:

```bash
# Inspect current state first; confirm repository and Pages access on a 404.
gh api repos/lboel/untangle/pages

# Create only when absent; do not repeat after a successful creation.
gh api --method POST repos/lboel/untangle/pages -f build_type=workflow
```

For an existing site using the legacy branch builder, deliberately change its
`build_type` to `workflow` with the update endpoint instead of creating another
site. Preserve custom-domain and access settings. A rejected eligibility or
permissions response requires human action; it is not permission to make the
repository public. See the [Pages administration API](https://docs.github.com/en/rest/pages/pages).

## Deployment source and workflow

[Website Pages](../.github/workflows/pages.yml) runs on website/workflow changes
pushed to `main` and can be dispatched manually on `main`. Branch dispatches are
skipped. Before first publication, verify the release candidate and advance
`main` to the exact reviewed commit. The workflow checks out `github.sha` with
persisted Git credentials disabled.

The build uses Node 24 and the existing dependency-free website scripts:

```bash
node apps/website/scripts/check.mjs src
node apps/website/scripts/build.mjs
node apps/website/scripts/check.mjs dist
```

There is no package installation or external asset fetch in the website build.
Full repository/unit and release-matrix validation remain separate required
release checks; the website workflow is not their substitute.

The publication workflow then copies the website package's complete `LICENSE`
and `NOTICE` into the output, after checking that both inputs are regular files.
These are publication-specific additions to the website's nine-asset build.
Existing output paths are never overwritten during this copy.

Before upload, an exact allowlist verifies eleven regular files, checks their bytes
against the selected source commit and records their hashes in the run summary:

- `LICENSE`
- `NOTICE`
- `index.html`
- `site.js`
- `story.js`
- `styles.css`
- `untangle-example.html`
- `untangle-example.json`
- `untangle-logo.svg`
- `untangle-yarn-3d.png`
- `yarn-scene.js`

**Only `apps/website/dist/` is uploaded.** The remaining repository source, Git metadata,
`.untangle/` evidence and indexes, credentials, unrelated README assets and package tarballs
are outside this artifact. Source and output symlinks are rejected. Adding a
website asset requires an explicit build and publication-allowlist change.

The yarn PNG is an explicitly selected copy of the canonical brand illustration,
including its native transparency and embedded prompt. The story controller imports
the local renderer module; neither script loads a CDN, analytics service or external
image. The scrolling scene is illustrative geometry, not a measured feature graph.

The two example files are a separately checked, frozen map of Untangle's real
codebase at `d11bdaf`. They publish selected relative paths, declared relationships,
scope-wide metric totals, coverage and source provenance. Source text and
machine-local paths are excluded. The HTML reuses the product viewer with a
hash-restricted, no-network Content Security Policy; the landing page embeds it
in a script-only sandbox and also links to its full-size view. This snapshot is
separate from the illustrative scroll story and from the current website commit.

The example's measurement provenance remains pinned to that snapshot. Its renderer
has a separate Git revision, source/Dist manifests and build receipt. Regenerating
the HTML for the **Untangle by feature** animation preserves the graph and all
measurement metadata. Grouping follows declared scopes; shared context and
unassigned nodes stay explicit. It is a layout transition, not a refactoring or
an inferred feature assignment. The map starts still and supports reduced motion.

The deployment job needs the successful build and uses the `github-pages`
environment. It receives only Pages-write and OIDC-token permissions. The build
has repository/Pages-read access. A shared concurrency group allows one deployment
at a time without cancelling an in-progress publication. All actions are pinned
to reviewed immutable revisions; their corresponding stable release versions are
recorded in workflow comments.

The expected default project URL is `https://lboel.github.io/untangle/`. Treat that
as an expectation until the actual deployment returns it. Relative stylesheet,
script and logo URLs support this project subpath. The landing page starts with the published
npm CLI and shows project-local, one-off and global installation commands.

The same public artifact includes the complete license and notice at
`https://lboel.github.io/untangle/LICENSE` and
`https://lboel.github.io/untangle/NOTICE`. Verify those responses against the
reviewed package files after deployment; their presence makes neither the private
repository nor unrelated source files public.

## Verify and recover

After the workflow is available on `main`, a deliberate manual deployment uses:

```bash
gh workflow run pages.yml --repo lboel/untangle --ref main
gh run list --repo lboel/untangle --workflow pages.yml --limit 5
```

Record the workflow run, source SHA, deployment/environment URL and terminal
result. Verify the deployed response and its local resource paths separately;
deployment success does not prove visual/accessibility quality. Preserve failed
runs and inspect their reason before another attempt. To roll back, deliberately
restore the intended website source on `main` and deploy that reviewed commit.

The website itself adds no analytics or automatic external resources. GitHub
still operates the hosting infrastructure and records visitor IP addresses for
security; see [GitHub Pages data collection](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection).
Website materials keep the repository's [licensing terms](./LICENSING.md).

This uses GitHub's [custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
and [artifact deployment](https://github.com/actions/deploy-pages) contracts.
