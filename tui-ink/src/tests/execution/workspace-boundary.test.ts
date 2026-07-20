import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { WorkspaceBoundary } from "../../execution/WorkspaceBoundary.js";

describe("WorkspaceBoundary", () => {
  const root = path.resolve("tmp", "workspace-boundary-root");

  it("resolves relative paths inside the workspace", () => {
    const boundary = new WorkspaceBoundary(root);
    const result = boundary.resolveInside("src/file.ts");
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(root, "src", "file.ts"));
  });

  it("allows the workspace root itself", () => {
    const boundary = new WorkspaceBoundary(root);
    const result = boundary.resolveInside(".");
    assert.equal(result.ok, true);
    assert.equal(result.path, root);
  });

  it("rejects parent-directory traversal", () => {
    const boundary = new WorkspaceBoundary(root);
    const result = boundary.resolveInside("..");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "outside_workspace");
  });

  it("rejects empty paths", () => {
    const boundary = new WorkspaceBoundary(root);
    const result = boundary.resolveInside(" ");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_path");
  });
});
