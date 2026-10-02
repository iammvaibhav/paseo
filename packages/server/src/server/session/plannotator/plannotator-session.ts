import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  PlannotatorSessionManager,
  type PlannotatorSessionEventPayload,
} from "../../../services/plannotator/session-manager.js";

export interface PlannotatorSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface PlannotatorSessionOptions {
  host: PlannotatorSessionHost;
  logger: pino.Logger;
  binaryPath?: string | null;
}

type PlannotatorRequest = Extract<
  SessionInboundMessage,
  {
    type: "plannotator.session.start.request" | "plannotator.session.stop.request";
  }
>;

export class PlannotatorSession {
  private readonly host: PlannotatorSessionHost;
  private readonly logger: pino.Logger;
  private readonly manager: PlannotatorSessionManager;

  constructor(options: PlannotatorSessionOptions) {
    this.host = options.host;
    this.logger = options.logger;
    this.manager = new PlannotatorSessionManager({
      logger: options.logger,
      binaryPath: options.binaryPath,
      onEvent: (event) => this.emitSessionEvent(event),
    });
  }

  isAvailable(): boolean {
    return this.manager.isAvailable();
  }

  async dispose(): Promise<void> {
    await this.manager.stopAll();
  }

  async handleStartRequest(
    request: Extract<SessionInboundMessage, { type: "plannotator.session.start.request" }>,
  ): Promise<void> {
    try {
      if (request.kind === "review") {
        const result = await this.manager.startReviewSession({
          workspaceDir: request.workspaceDir,
          prUrl: request.prUrl,
          agentId: request.agentId,
          workspaceKey: request.workspaceKey,
          remote: request.remote,
        });
        this.emitStartResponse(request.requestId, result);
        return;
      }

      if (!request.path) {
        this.emitStartResponse(request.requestId, {
          error: "plannotator annotate requires a path",
        });
        return;
      }

      const result = await this.manager.startAnnotateSession({
        path: request.path,
        workspaceDir: request.workspaceDir,
        agentId: request.agentId,
        workspaceKey: request.workspaceKey,
        remote: request.remote,
      });
      this.emitStartResponse(request.requestId, result);
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleStopRequest(
    request: Extract<SessionInboundMessage, { type: "plannotator.session.stop.request" }>,
  ): Promise<void> {
    try {
      const result = await this.manager.stopSession(request.sessionId);
      this.host.emit({
        type: "plannotator.session.stop.response",
        payload: {
          requestId: request.requestId,
          sessionId: request.sessionId,
          error: result.error,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private emitStartResponse(
    requestId: string,
    result: { sessionId: string; port: number; url: string } | { error: string },
  ): void {
    if ("error" in result) {
      this.host.emit({
        type: "plannotator.session.start.response",
        payload: { requestId, sessionId: null, port: null, url: null, error: result.error },
      });
      return;
    }
    this.host.emit({
      type: "plannotator.session.start.response",
      payload: {
        requestId,
        sessionId: result.sessionId,
        port: result.port,
        url: result.url,
        error: null,
      },
    });
  }

  private emitSessionEvent(event: PlannotatorSessionEventPayload): void {
    if (event.event === "feedback") {
      this.host.emit({
        type: "plannotator.session.event",
        payload: {
          sessionId: event.sessionId,
          kind: event.kind,
          path: event.path,
          ...(event.agentId ? { agentId: event.agentId } : {}),
          ...(event.workspaceKey ? { workspaceKey: event.workspaceKey } : {}),
          event: "feedback",
          decision: event.decision,
          // Client uses this string as the agent prompt (already formatted).
          feedback: event.prompt,
          ...(event.raw !== undefined ? { raw: event.raw } : {}),
        },
      });
      return;
    }

    this.host.emit({
      type: "plannotator.session.event",
      payload: {
        sessionId: event.sessionId,
        kind: event.kind,
        path: event.path,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.workspaceKey ? { workspaceKey: event.workspaceKey } : {}),
        event: "closed",
      },
    });
  }

  private emitError(request: PlannotatorRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Plannotator request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "plannotator_request_failed",
      },
    });
  }
}
