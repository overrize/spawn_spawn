export type InboundSource = "feishu" | "tui";

export interface ReplyTarget {
  replyId: string;
  replyType: "open_id" | "chat_id";
  rootMessageId?: string;
}

export interface InboundMessage {
  source: InboundSource;
  conversationId: string;
  senderId: string;
  messageId: string;
  text: string;
  chatId?: string;
  chatType?: string;
  messageType?: string;
  replyTarget?: ReplyTarget;
  raw?: unknown;
  receivedAt: number;
}
