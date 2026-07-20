import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TurnController } from "../../runtime/TurnController.js";

describe("TurnController", () => {
  it("resets per-turn action flags on beginTurn", () => {
    const turn = new TurnController();
    turn.beginTurn();
    turn.markUserReply();
    turn.endTurn();
    turn.beginTurn();
    assert.deepEqual(turn.snapshot(), {
      running: true,
      acted: false,
      sentToUser: false,
      reportedToParent: false,
      continuations: 0,
      gaveUp: false,
      nudgePending: false,
    });
  });

  it("marks user replies and parent reports as actions", () => {
    const turn = new TurnController();
    turn.beginTurn();
    turn.markUserReply();
    assert.equal(turn.snapshot().acted, true);
    assert.equal(turn.snapshot().sentToUser, true);
    turn.beginTurn();
    turn.markParentReport();
    assert.equal(turn.snapshot().acted, true);
    assert.equal(turn.snapshot().reportedToParent, true);
  });

  it("tracks nudge continuations and gives up at the configured limit", () => {
    const turn = new TurnController();
    turn.beginTurn();
    assert.equal(turn.requestNudge(3), true);
    turn.beginTurn();
    assert.equal(turn.requestNudge(3), true);
    turn.beginTurn();
    assert.equal(turn.requestNudge(3), true);
    turn.beginTurn();
    assert.equal(turn.requestNudge(3), false);
    assert.equal(turn.snapshot().gaveUp, true);
    assert.equal(turn.snapshot().continuations, 3);
  });

  it("clears continuation count after a non-nudge new turn", () => {
    const turn = new TurnController();
    turn.beginTurn();
    turn.requestNudge(3);
    turn.beginTurn();
    assert.equal(turn.snapshot().continuations, 1);
    turn.beginTurn();
    assert.equal(turn.snapshot().continuations, 0);
  });
});
