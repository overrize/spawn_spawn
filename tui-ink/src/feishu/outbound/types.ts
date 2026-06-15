/** Shared types for the OutboundGateway pipeline. */

export interface OutboundMsg {
  text: string;
  format?: "text" | "document";
  _fallback: boolean;
  agentId: string;
}

export interface OutboundContext {
  /** PM agent ID — used to look up the aggregator and pending artifacts. */
  pmId: string;
  /** true when running in Feishu conversation mode (as opposed to TUI-only). */
  conversationMode: boolean;
  /** true when this PM has at least one in-flight TL/Worker child. */
  hasActiveChildren: boolean;
}
