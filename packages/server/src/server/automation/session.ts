import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { AutomationService } from "./service.js";

type AutomationRequest = Extract<SessionInboundMessage, { type: `automation.${string}.request` }>;

// Client request surface for the unified Automations facade (schedules +
// webhooks + GitHub/Linear poll triggers). Thin delegation to
// AutomationService; the schedule/webhook sessions keep serving legacy RPCs.
export class AutomationSession {
  private readonly host: { emit: (msg: SessionOutboundMessage) => void };
  private readonly service: () => AutomationService | null;
  private readonly logger: pino.Logger;

  constructor(options: {
    host: { emit: (msg: SessionOutboundMessage) => void };
    service: () => AutomationService | null;
    logger: pino.Logger;
  }) {
    this.host = options.host;
    this.service = options.service;
    this.logger = options.logger;
  }

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!isAutomationRequest(message)) return undefined;
    switch (message.type) {
      case "automation.list.request":
        return this.handleList(message);
      case "automation.create.request":
        return this.handleCreate(message);
      case "automation.inspect.request":
        return this.handleInspect(message);
      case "automation.update.request":
        return this.handleUpdate(message);
      case "automation.delete.request":
        return this.handleDelete(message);
      case "automation.run.request":
        return this.handleRun(message);
      case "automation.status.request":
        return this.handleStatus(message);
    }
  }

  private requireService(request: AutomationRequest): AutomationService | null {
    const service = this.service();
    if (!service) {
      this.emitError(request, new Error("Automations are not enabled on this host"));
      return null;
    }
    return service;
  }

  private emitError(request: AutomationRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Automation request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "automation_request_failed",
      },
    });
  }

  private async handleList(
    request: Extract<SessionInboundMessage, { type: "automation.list.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const automations = await service.list();
      this.host.emit({
        type: "automation.list.response",
        payload: { requestId: request.requestId, error: null, automations },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleCreate(
    request: Extract<SessionInboundMessage, { type: "automation.create.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const automation = await service.create({
        name: request.name ?? null,
        kind: request.kind,
        target: request.target,
        promptTemplate: request.promptTemplate,
        ...(request.schedule !== undefined ? { schedule: request.schedule } : {}),
        ...(request.webhook !== undefined ? { webhook: request.webhook } : {}),
        ...(request.poll !== undefined ? { poll: request.poll } : {}),
      });
      this.host.emit({
        type: "automation.create.response",
        payload: { requestId: request.requestId, error: null, automation },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleInspect(
    request: Extract<SessionInboundMessage, { type: "automation.inspect.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const automation = await service.inspect(request.automationId);
      this.host.emit({
        type: "automation.inspect.response",
        payload: { requestId: request.requestId, error: null, automation },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleUpdate(
    request: Extract<SessionInboundMessage, { type: "automation.update.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const automation = await service.update({
        automationId: request.automationId,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
        ...(request.target !== undefined ? { target: request.target } : {}),
        ...(request.promptTemplate !== undefined ? { promptTemplate: request.promptTemplate } : {}),
        ...(request.schedule !== undefined ? { schedule: request.schedule } : {}),
        ...(request.webhook !== undefined ? { webhook: request.webhook } : {}),
        ...(request.poll !== undefined ? { poll: request.poll } : {}),
      });
      this.host.emit({
        type: "automation.update.response",
        payload: { requestId: request.requestId, error: null, automation },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleDelete(
    request: Extract<SessionInboundMessage, { type: "automation.delete.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      await service.delete(request.automationId);
      this.host.emit({
        type: "automation.delete.response",
        payload: { requestId: request.requestId, error: null, automationId: request.automationId },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleRun(
    request: Extract<SessionInboundMessage, { type: "automation.run.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const run = await service.run(request.automationId, request.samplePayload);
      this.host.emit({
        type: "automation.run.response",
        payload: { requestId: request.requestId, error: null, run },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async handleStatus(
    request: Extract<SessionInboundMessage, { type: "automation.status.request" }>,
  ): Promise<void> {
    const service = this.requireService(request);
    if (!service) return;
    try {
      const status = await service.status();
      this.host.emit({
        type: "automation.status.response",
        payload: { requestId: request.requestId, error: null, ...status },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }
}

function isAutomationRequest(message: SessionInboundMessage): message is AutomationRequest {
  return message.type.startsWith("automation.");
}
