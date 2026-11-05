# Repository licensing

Untangle uses **GNU Affero General Public License, Version 3 only
(`AGPL-3.0-only`)** across its first-party repository. The complete, unchanged
license text is in [LICENSE](../LICENSE); [NOTICE](../NOTICE) records the project
owner's binding choice. This document describes that choice and its scope rather
than creating another license.

## What the repository license covers

The same license applies to Untangle's first-party:

- Source code, CLI, MCP runtime and analysis packages.
- Build/development scripts, tests, fixtures and configuration.
- Documentation and the website.
- Logos, SVG marks and 3D yarn brand illustrations supplied with the project.

There is no separately licensed enterprise component, documentation exception,
permissive SDK exception or alternate commercial license in this repository.
Brand source files and illustration provenance are described in
[the brand guide](./BRAND.md). A brand image is illustrative artwork, not evidence
of a code analysis or a product screenshot.

The license does not grant trademark rights. Running Untangle against another
repository does not replace that repository's license; its code, documentation and
other assets retain their own terms.

## Third-party material retains its own terms

Dependencies and embedded language grammars remain third-party works under their
own licenses and copyright notices. Do not replace those notices with Untangle's
license or describe every file in a dependency tree as AGPL-licensed.

- Each publishable package includes a generated `THIRD_PARTY_LICENSES.md` covering
  its installed production dependency tree.
- [Grammar provenance](../scripts/astgrep-grammar-provenance.json) records the
  licenses and notices of embedded tree-sitter grammars separately from their
  language-package wrappers.
- The lockfile identifies resolved versions. A verified release bundle includes
  an SBOM and the original package tarballs.
- External analyzers such as SonarQube and Sentrux keep their own licenses. Offering
  a setup recipe or extension does not relicense their binaries or services.

## How licensing is checked

The root manifest and all current workspace manifests declare `AGPL-3.0-only`.
Every package directory carries regular, byte-identical copies of the root
`LICENSE` and `NOTICE`, including private packages. The sync command writes copies;
its check mode writes nothing:

```bash
pnpm sync-licenses --check
pnpm check-licenses
pnpm check-publishable
```

The checks have distinct scopes. `sync-licenses --check` detects missing, altered or
symlinked license/notice copies. `check-licenses` checks the production dependency
allowlist and recorded embedded-grammar licenses. `check-publishable` inspects
actual public-package tarballs for their license declarations, notices, source
files and current third-party records. A passing check does not publish anything.

## Source availability and release decisions

Use the actual [AGPL text](../LICENSE) for redistribution, modification and network
interaction requirements, including Corresponding Source and section 13. The GNU
project also publishes the [official AGPL text](https://www.gnu.org/licenses/agpl-3.0.en.html).

The local stdio MCP tool `untangle_about` exposes the license and source repository,
plus the build commit when supplied. An unknown commit is reported explicitly.
These fields do not establish access to a particular deployed version's source.
Review source availability for the concrete distribution or network deployment.

Original Untangle work is attributed to **Luke Bölling and contributors**. Contributors
retain copyright in their contributions; dependencies and grammars retain their own
attributions. Pull requests use AGPL-3.0-only without a separate CLA, copyright assignment
or DCO gate; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Trademark checks, npm scope rights and concrete network-deployment source availability
remain the project owner's release items in [NOTICE](../NOTICE). Neither this document
nor a badge marks those items complete.
