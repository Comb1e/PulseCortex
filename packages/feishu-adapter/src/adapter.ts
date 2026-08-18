import {
  Domain, LoggerLevel, createLarkChannel,
  type CardActionEvent, type LarkChannel, type LarkChannelError, type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import { parseCommand, redact, type ChannelAction, type ChannelCommand, type MessagingAdapter, type MessageRef, type ApprovalResolutionView, type ApprovalView, type ChoiceView, type OutputView, type QuestionView, type SessionView, type TurnResultView } from "@pulsecortex/domain";
import type { ControllerStore } from "@pulsecortex/persistence";
import { approvalCard, choiceCard, outputCard, questionCard, resolvedApprovalCard, resultCard, statusCard } from "./cards.js";

interface ChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: NormalizedMessage) => Promise<void>): unknown;
  on(name: "cardAction", handler: (action: CardActionEvent) => Promise<void>): unknown;
  on(name: "error" | "reconnecting" | "reconnected", handler: (...args: never[]) => void): unknown;
  send(to: string, input: { text: string } | { card: object }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  recallMessage?(messageId: string): Promise<void>;
  getConnectionStatus?(): unknown;
}

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  store: ControllerStore;
  channel?: ChannelLike;
  onConnectionChange?: (connected: boolean) => void;
  onOutboundMessage?: (message: FeishuOutboundMessage) => void;
}

export interface FeishuOutboundMessage {
  kind: "text" | "status" | "approval" | "result" | "choices" | "question" | "output";
  operation: "send" | "update" | "remove";
  chatId: string;
  messageId?: string;
  content: unknown;
}

type RawMessage = { sender?: { tenant_key?: string } };
type RawAction = { token?: string; header?: { event_id?: string; tenant_key?: string } };

function tenantFromMessage(message: NormalizedMessage): string {
  return (message.raw as RawMessage | undefined)?.sender?.tenant_key ?? "unknown-tenant";
}

function actionValue(event: CardActionEvent): { kind?: string; token?: string; value?: string } {
  return event.action.value && typeof event.action.value === "object" ? event.action.value as { kind?: string; token?: string; value?: string } : {};
}

function eventIdForAction(event: CardActionEvent): string {
  const raw = event.raw as RawAction | undefined;
  return raw?.header?.event_id ?? raw?.token ?? `card:${event.messageId}:${event.operator.openId}:${JSON.stringify(event.action.value)}`;
}

function isTransient(error: unknown): boolean {
  const code = (error as LarkChannelError | undefined)?.code;
  return code === "rate_limited" || code === "send_timeout" || code === "not_connected" || code === "unknown";
}

export async function retryTransient<T>(operation: () => Promise<T>, attempts = 5, baseDelayMs = 250): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts - 1) throw error;
      const ceiling = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(ceiling / 2 + Math.random() * ceiling / 2)));
    }
  }
  throw lastError;
}

export class FeishuAdapter implements MessagingAdapter {
  private readonly channel: ChannelLike;
  private commandHandler: ((command: ChannelCommand) => Promise<void>) | null = null;
  private actionHandler: ((action: ChannelAction) => Promise<void>) | null = null;
  private handlersRegistered = false;

  constructor(private readonly options: FeishuAdapterOptions) {
    this.channel = options.channel ?? createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.domain === "lark" ? Domain.Lark : Domain.Feishu,
      transport: "websocket",
      source: "pulsecortex",
      includeRawEvent: true,
      handshakeTimeoutMs: 15_000,
      loggerLevel: LoggerLevel.warn,
      policy: { dmMode: "open", groupAllowlist: [], requireMention: false, respondToMentionAll: false },
      safety: { dedup: { ttl: 10 * 60_000, maxEntries: 10_000 }, chatQueue: { enabled: true }, staleMessageWindowMs: 5 * 60_000 },
      outbound: { textChunkLimit: 3_500, retry: { maxAttempts: 1, baseDelayMs: 250 }, ssrfGuard: true },
    }) as LarkChannel;
  }

  async connect(): Promise<void> {
    if (!this.handlersRegistered) {
      this.handlersRegistered = true;
      this.channel.on("message", async (message) => this.acceptMessage(message));
      this.channel.on("cardAction", async (action) => this.acceptAction(action));
      this.channel.on("reconnecting", () => this.options.onConnectionChange?.(false));
      this.channel.on("reconnected", () => this.options.onConnectionChange?.(true));
      this.channel.on("error", () => this.options.onConnectionChange?.(false));
    }
    await this.channel.connect();
    this.options.onConnectionChange?.(true);
  }

  async disconnect(): Promise<void> { await this.channel.disconnect(); this.options.onConnectionChange?.(false); }
  onCommand(handler: (command: ChannelCommand) => Promise<void>): void { this.commandHandler = handler; }
  onAction(handler: (action: ChannelAction) => Promise<void>): void { this.actionHandler = handler; }

  async acceptMessage(message: NormalizedMessage): Promise<void> {
    const eventId = message.messageId;
    if (!this.options.store.claimEvent(eventId) || message.chatType !== "p2p" || message.rawContentType !== "text") return;
    const parsed = parseCommand(message.content);
    const actor = { tenantId: tenantFromMessage(message), userId: message.senderId, chatId: message.chatId, chatType: message.chatType } as const;
    const owner = this.options.store.getOwner();
    if (owner && !this.options.store.isOwner(actor)) {
      this.options.store.audit({ eventType: "authorization.rejected", summary: "Message from unknown Feishu user rejected", actor });
      return;
    }
    if (!owner && parsed.name !== "pair") return;
    if (owner) this.options.store.setOwnerChat(actor, message.chatId);
    const command = { eventId, messageId: message.messageId, actor, name: parsed.name, args: parsed.args, text: parsed.text, receivedAt: message.createTime } as ChannelCommand;
    void Promise.resolve(this.commandHandler?.(command)).catch((error) => this.options.store.audit({ eventType: "handler.failed", summary: redact((error as Error).message).slice(0, 500), actor }));
  }

  async acceptAction(event: CardActionEvent): Promise<void> {
    const owner = this.options.store.getOwner();
    if (!owner) return;
    const raw = event.raw as RawAction | undefined;
    const actor = { tenantId: raw?.header?.tenant_key ?? owner.tenantId, userId: event.operator.openId, chatId: event.chatId || owner.chatId, chatType: "p2p" as const };
    const eventId = eventIdForAction(event);
    if (!this.options.store.claimEvent(eventId) || !this.options.store.isOwner(actor)) {
      this.options.store.audit({ eventType: "authorization.rejected", summary: "Card action from unknown or duplicate actor rejected", actor });
      return;
    }
    const value = actionValue(event);
    if (!value.kind || !value.token) return;
    const action = { eventId, actor, kind: value.kind as ChannelAction["kind"], token: value.token, ...(value.value === undefined ? {} : { value: value.value }), receivedAt: Date.now() } as ChannelAction;
    void Promise.resolve(this.actionHandler?.(action)).catch((error) => this.options.store.audit({ eventType: "handler.failed", summary: redact((error as Error).message).slice(0, 500), actor }));
  }

  async sendStatus(view: SessionView): Promise<MessageRef> {
    const ref = await this.sendCard(statusCard(view));
    const { actionTokens: _, ...content } = view;
    this.reportOutbound({ kind: "status", operation: "send", ...ref, content });
    return ref;
  }
  async updateStatus(ref: MessageRef, view: SessionView): Promise<void> {
    await retryTransient(() => this.channel.updateCard(ref.messageId, statusCard(view)));
    const { actionTokens: _, ...content } = view;
    this.reportOutbound({ kind: "status", operation: "update", ...ref, content });
  }
  async sendApproval(view: ApprovalView): Promise<MessageRef> {
    const ref = await this.sendCard(approvalCard(view));
    const { actionTokens: _, ...content } = view;
    this.reportOutbound({ kind: "approval", operation: "send", ...ref, content });
    return ref;
  }
  async updateApproval(ref: MessageRef, resolution: ApprovalResolutionView): Promise<void> {
    await retryTransient(() => this.channel.updateCard(ref.messageId, resolvedApprovalCard(resolution)));
    this.reportOutbound({ kind: "approval", operation: "update", ...ref, content: resolution });
  }
  async removeApproval(ref: MessageRef): Promise<void> {
    if (!this.channel.recallMessage) return;
    await retryTransient(() => this.channel.recallMessage!(ref.messageId));
    this.reportOutbound({ kind: "approval", operation: "remove", ...ref, content: { removed: true } });
  }
  async sendResult(view: TurnResultView): Promise<void> {
    const ref = await this.sendCard(resultCard(view));
    const { actionTokens: _, ...content } = view;
    this.reportOutbound({ kind: "result", operation: "send", ...ref, content });
  }
  async updateResult(ref: MessageRef, view: TurnResultView): Promise<void> {
    await retryTransient(() => this.channel.updateCard(ref.messageId, resultCard(view)));
    const { actionTokens: _, ...content } = view;
    this.reportOutbound({ kind: "result", operation: "update", ...ref, content });
  }
  async sendChoices(view: ChoiceView): Promise<void> {
    const ref = await this.sendCard(choiceCard(view));
    const { previousToken: _, nextToken: __, ...safeView } = view;
    const content = { ...safeView, choices: view.choices.map(({ token: ___, value: ____, ...choice }) => choice) };
    this.reportOutbound({ kind: "choices", operation: "send", ...ref, content });
  }
  async sendQuestion(view: QuestionView): Promise<void> {
    const ref = await this.sendCard(questionCard(view));
    const content = { ...view, options: view.options.map(({ token: _, value: __, ...option }) => option) };
    this.reportOutbound({ kind: "question", operation: "send", ...ref, content });
  }
  async sendOutput(view: OutputView): Promise<void> {
    const ref = await this.sendCard(outputCard(view));
    const { previousToken: _, nextToken: __, ...content } = view;
    this.reportOutbound({ kind: "output", operation: "send", ...ref, content });
  }
  async sendText(text: string): Promise<void> {
    const chatId = this.ownerChat(); const safe = redact(text); const bounded = safe.length > 3_500 ? `${safe.slice(0, 3_460)}\n[Output truncated]` : safe;
    const sent = await retryTransient(() => this.channel.send(chatId, { text: bounded }));
    this.reportOutbound({ kind: "text", operation: "send", chatId, messageId: sent.messageId, content: bounded });
  }
  connectionStatus(): unknown { return this.channel.getConnectionStatus?.(); }

  private async sendCard(card: object): Promise<MessageRef> {
    const chatId = this.ownerChat();
    const sent = await retryTransient(() => this.channel.send(chatId, { card }));
    return { messageId: sent.messageId, chatId };
  }

  private ownerChat(): string {
    const chatId = this.options.store.getOwner()?.chatId;
    if (!chatId) throw new Error("The paired owner has no direct-chat destination yet");
    return chatId;
  }

  private reportOutbound(message: FeishuOutboundMessage): void {
    this.options.onOutboundMessage?.(message);
  }
}
