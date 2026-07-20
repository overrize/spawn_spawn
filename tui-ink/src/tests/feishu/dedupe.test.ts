import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BoundedMessageDeduper } from "../../feishu/dedupe.js";

describe("BoundedMessageDeduper", () => {
  it("returns true only for repeated message ids", () => {
    const d = new BoundedMessageDeduper(10);

    assert.equal(d.checkAndAdd("msg-1"), false);
    assert.equal(d.checkAndAdd("msg-1"), true);
    assert.equal(d.checkAndAdd("msg-2"), false);
    assert.equal(d.checkAndAdd("msg-2"), true);
  });

  it("evicts oldest ids when the bound is exceeded", () => {
    const d = new BoundedMessageDeduper(2);

    d.add("msg-1");
    d.add("msg-2");
    d.add("msg-3");

    assert.equal(d.has("msg-1"), false);
    assert.equal(d.has("msg-2"), true);
    assert.equal(d.has("msg-3"), true);
  });
});
