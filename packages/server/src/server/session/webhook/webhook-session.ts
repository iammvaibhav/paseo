import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { WebhookService } from "../../webhook/service.js";

export interface WebhookSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface WebhookSessionOptions {
  host: WebhookSessionHost;
  webhookService: WebhookService | null;
  logger: pino.Logger;
}

type WebhookRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "webhook/create"
      | "webhook/list"
      | "webhook/inspect"
      | "webhook/delete"
      | "webhook/update"
      | "webhook/test"
      | "webhook/config";
  }
>;

// Client request surface for webhooks. Stateless request/response over the
// WebhookService, mirroring the schedule session. Held nullable so the daemon
// can construct a session even when the webhook subsystem is absent.
export class WebhookSession {
  private readonly host: WebhookSessionHost;
  private readonly service: WebhookService | null;
  private readonly logger: pino.Logger;

  constructor(options: WebhookSessionOptions) {
    this.host = options.host;
    this.service = options.webhookService;
    this.logger = options.logger;
  }

  private emitError(request: WebhookRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Webhook request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "webhook_request_failed",
      },
    });
  }

  private requireService(request: WebhookRequest): WebhookService | null {
    if (!this.service) {
      this.emitError(request, new Error("Webhooks are not enabled on this host"));
      return null;
    }
    return this.service;
  }

  async handleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/create" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const webhook = await service.create({
        name: request.name,
        enabled: request.enabled,
        target: request.target,
        promptTemplate: request.promptTemplate,
        auth: request.auth,
        filter: request.filter,
      });
      this.host.emit({
        type: "webhook/create/response",
        payload: { requestId: request.requestId, webhook, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/list" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const webhooks = await service.list();
      this.host.emit({
        type: "webhook/list/response",
        payload: {
          requestId: request.requestId,
          webhooks,
          publicBaseUrl: service.publicBaseUrl(),
          error: null,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleInspectRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/inspect" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const webhook = await service.inspect(request.webhookId);
      this.host.emit({
        type: "webhook/inspect/response",
        payload: {
          requestId: request.requestId,
          webhook,
          publicBaseUrl: service.publicBaseUrl(),
          error: null,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/delete" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      await service.delete(request.webhookId);
      this.host.emit({
        type: "webhook/delete/response",
        payload: { requestId: request.requestId, webhookId: request.webhookId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/update" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const webhook = await service.update({
        id: request.webhookId,
        name: request.name,
        enabled: request.enabled,
        target: request.target,
        promptTemplate: request.promptTemplate,
        auth: request.auth,
        filter: request.filter,
      });
      this.host.emit({
        type: "webhook/update/response",
        payload: { requestId: request.requestId, webhook, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleTestRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/test" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const result = await service.test(request.webhookId, request.samplePayload);
      this.host.emit({
        type: "webhook/test/response",
        payload: {
          requestId: request.requestId,
          delivery: result.delivery,
          renderedPrompt: result.renderedPrompt,
          error: result.error,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleConfigRequest(
    request: Extract<SessionInboundMessage, { type: "webhook/config" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) {
      return;
    }
    try {
      const config = service.getTunnelConfig();
      this.host.emit({
        type: "webhook/config/response",
        payload: {
          requestId: request.requestId,
          provider: config.provider,
          status: config.status,
          publicBaseUrl: config.publicBaseUrl,
          error: null,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }
}
