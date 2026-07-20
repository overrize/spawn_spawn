export interface TurnSnapshot {
  running: boolean;
  acted: boolean;
  sentToUser: boolean;
  reportedToParent: boolean;
  continuations: number;
  gaveUp: boolean;
  nudgePending: boolean;
}

export class TurnController {
  private state: TurnSnapshot = {
    running: false,
    acted: false,
    sentToUser: false,
    reportedToParent: false,
    continuations: 0,
    gaveUp: false,
    nudgePending: false,
  };

  beginTurn(): void {
    this.state.running = true;
    this.state.acted = false;
    this.state.sentToUser = false;
    this.state.reportedToParent = false;
    if (!this.state.nudgePending) {
      this.state.continuations = 0;
      this.state.gaveUp = false;
    }
    this.state.nudgePending = false;
  }

  markAction(): void {
    this.state.acted = true;
  }

  markUserReply(): void {
    this.state.acted = true;
    this.state.sentToUser = true;
  }

  markParentReport(): void {
    this.state.acted = true;
    this.state.reportedToParent = true;
  }

  requestNudge(maxContinuations: number): boolean {
    if (this.state.continuations >= maxContinuations) {
      this.state.gaveUp = true;
      return false;
    }
    this.state.continuations++;
    this.state.nudgePending = true;
    return true;
  }

  endTurn(): void {
    this.state.running = false;
  }

  snapshot(): TurnSnapshot {
    return { ...this.state };
  }
}
