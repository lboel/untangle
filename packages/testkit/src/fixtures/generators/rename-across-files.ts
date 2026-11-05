/**
 * Pflicht-Fixture 6 (spec.md §27.2): "Rename und Move über Dateien". Two
 * full snapshots — `before` and `after` — of the same tiny repo: a file is
 * renamed AND moved into a different directory, its content changes
 * slightly (a real rename detector must tolerate that, not require byte
 * identity), and a second file is updated to import it from the new path.
 *
 * Feed both snapshots to `FakeGitProvider.commit()` (base, then head) to
 * exercise `GitPort.listChangedFiles`/change-detection against a real
 * rename scenario.
 */
import type { FixtureFile } from "../types.js";

export interface RenameAcrossFilesFixture {
  before: FixtureFile[];
  after: FixtureFile[];
  groundTruth: {
    description: string;
    oldPath: string;
    newPath: string;
  };
}

export function generateRenameAcrossFiles(): RenameAcrossFilesFixture {
  const before: FixtureFile[] = [
    {
      path: "src/utils/formatDate.ts",
      content: [
        "export function formatDate(date: Date): string {",
        "  return date.toISOString().slice(0, 10);",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/report.ts",
      content: [
        'import { formatDate } from "./utils/formatDate.js";',
        "",
        "export function renderReport(date: Date): string {",
        "  return `report generated on ${formatDate(date)}`;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  const after: FixtureFile[] = [
    {
      // Moved into a new directory AND renamed.
      path: "src/formatting/date-format.ts",
      content: [
        "export function formatDate(date: Date): string {",
        "  // Minor real change alongside the rename/move — a rename",
        "  // detector must tolerate this, not require byte-identical content.",
        '  return date.toISOString().split("T")[0] ?? "";',
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/report.ts",
      content: [
        'import { formatDate } from "./formatting/date-format.js";',
        "",
        "export function renderReport(date: Date): string {",
        "  return `report generated on ${formatDate(date)}`;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  return {
    before,
    after,
    groundTruth: {
      description:
        "src/utils/formatDate.ts is renamed AND moved to src/formatting/date-format.ts with a small content change; src/report.ts's import is updated accordingly",
      oldPath: "src/utils/formatDate.ts",
      newPath: "src/formatting/date-format.ts",
    },
  };
}
