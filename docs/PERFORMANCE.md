<a id="performance--messung-engpässe-und-die-rust-frage"></a>

# Performance: measurements, bottlenecks and the Rust question

**As of 2026-09-05.** Sections 1, 2 and 4 were remeasured after WP-95; section 3's
embedding measurements remain from 2026-09-04. Measurements used the development
machine: Apple Silicon, Node 26, native `tree-sitter` 0.21.1 and Ollama
`qwen3-embedding:0.6b`.

**Principle:** measure before optimizing or choosing another technology.

<a id="1-gemessener-ist-zustand--nach-wp-95"></a>

## 1. Measured baseline after WP-95

Analysis of this repository: 738 files, 134,782 lines. Both revisions ran in the
same process in alternating order, taking each revision's best round
(`pnpm walk:messung`):

| Stage | Before (`.children`) | After (cursor) | Factor |
|---|---:|---:|---:|
| `parse` (tree-sitter + parse diagnostics) | 2,803 ms · 48.1 kLOC/s | **853 ms · 158.0 kLOC/s** | 3.29× |
| Traversal (complexity + regions + symbols) | 16,596 ms · 8.1 kLOC/s | **4,662 ms · 28.9 kLOC/s** | **3.56×** |
| Projections (chunks/symbols/imports/calls) | 40 ms | 26 ms | — |
| **Total** | **19,440 ms · 6.93 kLOC/s** | **5,541 ms · 24.32 kLOC/s** | **3.51×** |
| Traversal share | 85.4% | 84.1% | |

End-to-end `untangle complexity` on this repository, best of three runs per
revision: 943 files discovered, 733 measured, 223 skipped.

| | Before | After |
|---|---:|---:|
| Total runtime | **21.14 s** | **7.62 s** (2.77×) |

Text output and complete `--format=json` output are byte-identical: the same
hotspots, totals and skip ledger.

Traversal remains the largest cost at 84% rather than 86%, but is now faster
than parsing was previously.

<a id="2-die-ursache-war-die-jsc-grenze--und-noch-etwas"></a>

## 2. The cause: the JS/C boundary and an additional defect

The adapter already performed one memoized unified traversal per parse. The
problem was navigation: each `.children` access creates a JS array of node
wrappers and crosses into the native library once per node. The cursor keeps
its position natively.

An earlier microbenchmark over 24 KB and 6,682 nodes measured traversal at
1.39 µs/node through `.children`, versus 0.21 µs through the cursor: **6.5×**.
The real pipeline gains **3.5×**. That difference is the other work performed by
the traversal: constructing fact objects, converting ranges, two SHA-256 hashes
per scope, and still materializing node wrappers for calls, imports and scope
openings. The microbenchmark is not a pipeline performance promise.

The change covers three full-tree traversals: `engine.ts` for fact extraction,
`fingerprint.ts` for `astHash`/`tokenFingerprint` once per scope and root, and
`parse-diagnostics.ts`, which runs inside `parse()`. This explains the 3.29× gain
in what appeared to be a tree-sitter-only stage.

<a id="was-die-umstellung-nebenbei-aufgedeckt-hat"></a>

### What the change also uncovered

`tree-sitter@0.21.1` reports a node's type reliably only when the cursor descends
from the root. Neither `node.children` nor a cursor reset to a subtree
(`node.walk()`) knows the parent alias context. Both approaches misreported
**1,411 comment nodes in 207 files** as `interface_body` in this repository.

The previous behavior had three defects:

1. Those comments were missing from `ComplexityFacts.comments`.
2. They counted as Halstead operators, and therefore as code.
3. They entered `astHash` and `tokenFingerprint`, although both fingerprints
   explicitly exclude comments (`spec.md` §17.3). A comment-only edit appeared
   to change the symbol structurally.

Measured across 738 files and 10,328 symbols:

| | Before | After | Difference |
|---|---:|---:|---:|
| Halstead operators | 133,282 | 131,871 | **−1,411** comments previously counted as code |
| Comment ranges | 6,821 | 8,232 | **+1,411** previously missing comments |
| Symbols with changed fingerprints | — | — | **531 of 10,328** (5.1%), in 207 files |

The change fixes this behavior and is intentionally not result-neutral.
`scripts/walk-gegenprobe.mjs` executes both approaches over every source file and
shows that every one of the 207 differences is fully explained by this cause.
Chunk IDs, symbol IDs, AST regions, imports, call edges, decision points, nesting
events, operands, identifiers, literals and parse diagnostics remain unchanged.
Cyclomatic and cognitive metrics already exclude comments, so `complexity`
output remains byte-identical.

Regression: `packages/parser-registry/src/languages/shared/cursor-walk.test.ts`;
all four assertions fail on the pre-WP-95 revision.

<a id="3-was-bei-maßstab-wirklich-dominiert-embeddings"></a>

## 3. What dominates at scale: embeddings

Local Ollama, `qwen3-embedding:0.6b`, typical chunk ~900 characters:

| Batch size | Runtime | Throughput |
|---:|---:|---:|
| 1, cold, including model loading | 2,931 ms | 0.3 chunks/s |
| 8 | 209 ms | 38.3 chunks/s |
| 32 | 343 ms | **93.3 chunks/s** |

Batching gives roughly **300×** between batches of 1 and 32. `spec.md` §9.2
requires configurable batching; these measurements explain why.

<a id="4-hochrechnung"></a>

## 4. Extrapolation

Single-core, excluding I/O, using measured analysis throughput of 24.32 kLOC/s
from section 1, previously 6.93 kLOC/s. Embeddings assume ~25 chunks/kLOC and
93 chunks/s.

| Size | Previous analysis | Current analysis | Embeddings | Dominant stage |
|---|---:|---:|---:|---|
| 100 kLOC | 14 s | **4 s** | ~27 s | **Embeddings** |
| 1 MLOC | 2.4 min | **41 s** | ~4.5 min | **Embeddings** |
| 2.45 MLOC | 5.9 min | **1.7 min** | ~11 min | **Embeddings** |
| 40 MLOC | 1.6 h | **27 min** | ~3 h | **Embeddings** |

Per-file worker-thread parallelism, planned in `architecture.md` §13.1 but not
built at this revision, could additionally improve analysis roughly with the
number of available cores.

<a id="5-die-rust-frage--beantwortet"></a>

## 5. The Rust question

Not at this stage, based on measurements:

1. **The parser is already native C.** Replacing tree-sitter with Rust does not
   address its 12.5% runtime share.
2. **The main bottleneck had an implemented JavaScript solution.** Traversal used
   86.6% of runtime, mostly boundary crossings. The WP-95 cursor change achieved
   a measured **3.5×** without another language, build toolchain or
   platform-specific artifacts.
3. **Embeddings dominate after the change.** They depend on the GPU/model; Rust
   does not alter that constraint.
4. **Parallelism is the next option without another language.** Individual file
   analyses are independently parallelizable.

<a id="wann-rust-doch-die-richtige-antwort-wäre"></a>

### When Rust would be appropriate

Only after cursor-based traversal and worker parallelism are implemented, and
analysis remains the bottleneck across millions of lines. The useful boundary
would be a narrow native module performing the unified traversal and returning
finished `ComplexityFacts`, regions and symbols in one boundary crossing rather
than one per node, rather than rewriting everything in Rust.

Costs must be explicit: a second build toolchain, prebuilds for each platform and
architecture, an `npx` entry point requiring binary artifacts, and a higher
contribution barrier. `spec.md` §2.3 requires Linux, macOS and Windows, where every
native dependency adds maintenance. Measurements must justify this cost; these
measurements do not.

<a id="beobachtung-zu-vergleichbaren-werkzeugen"></a>

### Comparable tool architectures

Some mature local code-intelligence tools use Rust-based `ast-grep` through
napi. The transferable benefit is architectural: native traversal crosses the
boundary once rather than once per node. The language itself need not be copied.
`ast-grep` provides pattern matching rather than the full fact extraction needed
by Untangle's complexity engine: decision points, nesting events and Halstead
operators/operands. Swapping it in would provide a subset, not an equivalent
replacement.

<a id="6-offene-messungen"></a>

## 6. Unmeasured areas

- **Python adapter:** no measurements yet, because this repository has no `.py`
  files outside fixtures. The handwritten parser was both the largest complexity
  hotspot (679) and location of the most serious defect, WP-76; throughput still
  needs measurement.
- **I/O and hashing:** excluded from these figures.
- **Qdrant upserts:** unmeasured; byte budgets and multipart behavior may become
  independent bottlenecks at millions of points.
