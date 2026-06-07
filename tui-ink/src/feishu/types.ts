// Feishu Bot API TypeScript types (generated from feishu-bot-sop.md)

/* ------------------------------------------------------------------ */
/*  Token 响应 (SOP §2)                                                */
/* ------------------------------------------------------------------ */

export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

/* ------------------------------------------------------------------ */
/*  消息请求 (SOP §3)                                                  */
/* ------------------------------------------------------------------ */

export type FeishuMsgType =
  | 'text'
  | 'post'
  | 'image'
  | 'interactive'
  | 'share_chat'
  | 'share_user';

export type FeishuReceiveIdType =
  | 'open_id'
  | 'user_id'
  | 'chat_id'
  | 'email';

export interface FeishuMessageRequestBase {
  receive_id: string;
  receive_id_type: FeishuReceiveIdType;
  msg_type: FeishuMsgType;
  content: string;
}

// Union type supporting text / post / interactive (as required by acceptance criteria)
export type FeishuMessageRequest =
  | FeishuMessageRequestBase
  | (FeishuMessageRequestBase & { msg_type: 'text' })
  | (FeishuMessageRequestBase & { msg_type: 'post' })
  | (FeishuMessageRequestBase & { msg_type: 'interactive' });

/* ------------------------------------------------------------------ */
/*  消息内容结构 (SOP §3) — 供 message.ts 使用                          */
/* ------------------------------------------------------------------ */

/** 文本消息 content */
export interface FeishuTextContent {
  text: string;
}

/** 富文本消息 content（多语言支持） */
export interface FeishuPostElement {
  tag: 'text' | 'a' | 'at';
  text?: string;
  href?: string;
  user_id?: string;
  style?: string[];
}

export interface FeishuPostParagraph {
  title?: string;
  content: FeishuPostElement[][];
}

export interface FeishuPostContent {
  zh_cn?: FeishuPostParagraph;
  en_us?: FeishuPostParagraph;
  ja_jp?: FeishuPostParagraph;
}

/** 卡片消息 content (msg_type: 'interactive') */
export interface FeishuCardConfig {
  wide_screen_mode?: boolean;
  enable_forward?: boolean;
}

export interface FeishuCardHeaderTitle {
  tag: 'plain_text' | 'lark_md';
  content: string;
}

export interface FeishuCardHeader {
  title: FeishuCardHeaderTitle;
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey' | 'default';
}

export interface FeishuCardElement {
  tag: 'markdown' | 'hr' | 'note' | 'div' | 'action';
  content?: string;
  elements?: { tag: 'plain_text' | 'lark_md'; content: string }[];
}

export interface FeishuInteractiveContent {
  config?: FeishuCardConfig;
  header?: FeishuCardHeader;
  elements?: FeishuCardElement[];
}

/* ------------------------------------------------------------------ */
/*  消息响应 (SOP §3.7)                                                */
/* ------------------------------------------------------------------ */

export interface FeishuMessageId {
  open_id: string;
  user_id: string;
}

export interface FeishuMessageSender {
  id: FeishuMessageId;
}

export interface FeishuMessageData {
  message_id: string;
  root_id: string;
  parent_id: string;
  msg_type: string;
  create_time: string;
  update_time: string;
  sender: FeishuMessageSender;
}

export interface FeishuMessageResponse {
  code: number;
  msg: string;
  data?: FeishuMessageData;
}

/* ------------------------------------------------------------------ */
/*  URL 挑战验证 (SOP §4.2)                                            */
/* ------------------------------------------------------------------ */

/** URL 挑战查询参数 (GET) */
export interface FeishuUrlChallengeQuery {
  challenge: string;
  token: string;
  type: 'url_verification';
}

/* ------------------------------------------------------------------ */
/*  事件推送体 (SOP §4.3)                                              */
/* ------------------------------------------------------------------ */

export interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  create_time: string;
  token: string;
  app_id: string;
  tenant_key: string;
}

export interface FeishuEventSenderId {
  union_id: string;
  user_id: string;
  open_id: string;
}

export interface FeishuEventSender {
  sender_id: FeishuEventSenderId;
  sender_type: 'user' | 'bot';
}

export interface FeishuEventMessage {
  message_id: string;
  root_id: string;
  parent_id: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  message_type: string;
  content: string;
  create_time: string;
}

export interface FeishuEventBody {
  schema: string;
  header: FeishuEventHeader;
  event: {
    sender: FeishuEventSender;
    message: FeishuEventMessage;
  };
}

/* ------------------------------------------------------------------ */
/*  自定义错误类 FeishuError (含 httpStatus)                             */
/* ------------------------------------------------------------------ */

export class FeishuError extends Error {
  public readonly code: number;
  public readonly status?: number;
  public readonly httpStatus?: number;

  constructor(code: number, message: string, httpStatus?: number) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.status = httpStatus;
    this.httpStatus = httpStatus;
    // Ensure correct prototype chain
    Object.setPrototypeOf(this, FeishuError.prototype);
  }

  get isSuccess(): boolean {
    return this.code === 0;
  }

  static fromApiResponse(body: { code: number; msg: string }, httpStatus?: number): FeishuError {
    return new FeishuError(body.code, body.msg, httpStatus);
  }
}
