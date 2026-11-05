import { describe, expect, it } from "vitest";

import { FakeGitProvider } from "./git-provider.js";

describe("FakeGitProvider", () => {
  it("isRepository is false until initRepository is called", async () => {
    const git = new FakeGitProvider();
    expect(await git.isRepository("/repo")).toBe(false);
    git.initRepository("/repo");
    expect(await git.isRepository("/repo")).toBe(true);
  });

  it("commit() is deterministic: identical inputs yield the identical sha", () => {
    const gitA = new FakeGitProvider();
    gitA.initRepository("/repo");
    const shaA = gitA.commit(
      "/repo",
      "main",
      { "a.txt": "hello" },
      { message: "init", parents: [] },
    );

    const gitB = new FakeGitProvider();
    gitB.initRepository("/repo");
    const shaB = gitB.commit(
      "/repo",
      "main",
      { "a.txt": "hello" },
      { message: "init", parents: [] },
    );

    expect(shaA).toBe(shaB);
  });

  it("commit() with different content yields a different sha", () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha1 = git.commit("/repo", "main", { "a.txt": "hello" }, { parents: [] });
    const sha2 = git.commit("/repo", "main", { "a.txt": "hello", "b.txt": "world" });
    expect(sha1).not.toBe(sha2);
  });

  it("resolveCommit resolves commit/ref revisions; unknown ones resolve to null", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha = git.commit("/repo", "main", { "a.txt": "1" }, { parents: [] });

    expect(await git.resolveCommit("/repo", { kind: "commit", sha })).toBe(sha);
    expect(await git.resolveCommit("/repo", { kind: "ref", name: "main" })).toBe(sha);
    expect(await git.resolveCommit("/repo", { kind: "ref", name: "does-not-exist" })).toBeNull();
    expect(await git.resolveCommit("/repo", { kind: "commit", sha: "0000" })).toBeNull();
    expect(await git.resolveCommit("/unknown-repo", { kind: "ref", name: "main" })).toBeNull();
  });

  it("resolveCommit maps working_tree and index to the current branch's HEAD", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha = git.commit("/repo", "main", { "a.txt": "1" }, { parents: [] });
    expect(await git.resolveCommit("/repo", { kind: "working_tree" })).toBe(sha);
    expect(await git.resolveCommit("/repo", { kind: "index" })).toBe(sha);
  });

  it("resolveCommit resolves a generation only after registerGeneration", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha = git.commit("/repo", "main", { "a.txt": "1" }, { parents: [] });
    expect(
      await git.resolveCommit("/repo", { kind: "generation", generationId: "gen-1" }),
    ).toBeNull();
    git.registerGeneration("/repo", "gen-1", sha);
    expect(await git.resolveCommit("/repo", { kind: "generation", generationId: "gen-1" })).toBe(
      sha,
    );
  });

  it("currentBranch reflects the branch of the most recent commit, and checkout()", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    git.commit("/repo", "main", { "a.txt": "1" }, { parents: [] });
    expect(await git.currentBranch("/repo")).toBe("main");
    git.commit("/repo", "feature", { "b.txt": "2" }, { parents: [] });
    // Committing on a different branch does not switch the current branch.
    expect(await git.currentBranch("/repo")).toBe("main");
    git.checkout("/repo", "feature");
    expect(await git.currentBranch("/repo")).toBe("feature");
  });

  it("listTrackedFiles and readFileAtRevision reflect a commit's full snapshot", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha = git.commit(
      "/repo",
      "main",
      { "src/a.ts": "export const a = 1;", "src/b.ts": "export const b = 2;" },
      { parents: [] },
    );
    expect(await git.listTrackedFiles("/repo", { kind: "commit", sha })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    const content = await git.readFileAtRevision("/repo", { kind: "commit", sha }, "src/a.ts");
    expect(new TextDecoder().decode(content ?? new Uint8Array())).toBe("export const a = 1;");
    expect(
      await git.readFileAtRevision("/repo", { kind: "commit", sha }, "src/missing.ts"),
    ).toBeNull();
  });

  it("listChangedFiles reports added, modified and deleted files between two commits", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const base = git.commit(
      "/repo",
      "main",
      { "keep.ts": "same", "remove.ts": "gone soon", "change.ts": "before" },
      { parents: [] },
    );
    const head = git.commit("/repo", "main", {
      "keep.ts": "same",
      "change.ts": "after",
      "add.ts": "new file",
    });

    const changes = await git.listChangedFiles(
      "/repo",
      { kind: "commit", sha: base },
      {
        kind: "commit",
        sha: head,
      },
    );
    const byPath = new Map(changes.map((c) => [c.oldPath ?? c.newPath, c]));
    expect(byPath.get("remove.ts")).toMatchObject({ changeKind: "deleted", oldPath: "remove.ts" });
    expect(byPath.get("add.ts")).toMatchObject({ changeKind: "added", newPath: "add.ts" });
    expect(byPath.get("change.ts")).toMatchObject({
      changeKind: "modified",
      oldPath: "change.ts",
      newPath: "change.ts",
    });
    expect(changes.some((c) => (c.oldPath ?? c.newPath) === "keep.ts")).toBe(false);
  });

  it("listChangedFiles detects a same-content rename as one renamed entry", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const base = git.commit(
      "/repo",
      "main",
      { "old/name.ts": "identical content" },
      { parents: [] },
    );
    const head = git.commit("/repo", "main", { "new/name.ts": "identical content" });

    const changes = await git.listChangedFiles(
      "/repo",
      { kind: "commit", sha: base },
      {
        kind: "commit",
        sha: head,
      },
    );
    expect(changes).toEqual([
      { changeKind: "renamed", oldPath: "old/name.ts", newPath: "new/name.ts", similarity: 1 },
    ]);
  });

  it("remoteUrls returns the registered remotes, empty for an unknown repo", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo", ["https://example.invalid/repo.git"]);
    expect(await git.remoteUrls("/repo")).toEqual(["https://example.invalid/repo.git"]);
    expect(await git.remoteUrls("/unknown")).toEqual([]);
  });

  it("respects an already-aborted signal on every method", async () => {
    const git = new FakeGitProvider();
    git.initRepository("/repo");
    const sha = git.commit("/repo", "main", { "a.txt": "1" }, { parents: [] });
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(git.isRepository("/repo", { signal })).rejects.toThrow();
    await expect(
      git.resolveCommit("/repo", { kind: "ref", name: "main" }, { signal }),
    ).rejects.toThrow();
    await expect(git.currentBranch("/repo", { signal })).rejects.toThrow();
    await expect(
      git.listChangedFiles("/repo", { kind: "commit", sha }, { kind: "commit", sha }, { signal }),
    ).rejects.toThrow();
    await expect(
      git.readFileAtRevision("/repo", { kind: "commit", sha }, "a.txt", { signal }),
    ).rejects.toThrow();
    await expect(
      git.listTrackedFiles("/repo", { kind: "commit", sha }, { signal }),
    ).rejects.toThrow();
    await expect(git.remoteUrls("/repo", { signal })).rejects.toThrow();
  });
});
