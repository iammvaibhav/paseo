import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { FleetBrowserError, type FleetBrowserService } from "./service.js";

type FleetBrowserRequest = Extract<
  SessionInboundMessage,
  { type: `fleet_browser.${string}.request` }
>;
type RequestOf<T extends FleetBrowserRequest["type"]> = Extract<FleetBrowserRequest, { type: T }>;

function isRequest(message: SessionInboundMessage): message is FleetBrowserRequest {
  return message.type.startsWith("fleet_browser.") && message.type.endsWith(".request");
}

export interface FleetBrowserSessionOptions {
  emit(message: SessionOutboundMessage): void;
  service: FleetBrowserService | null;
  logger: pino.Logger;
}

/** Serves the app's fleet_browser.* requests for one client session. */
export class FleetBrowserSession {
  public constructor(private readonly options: FleetBrowserSessionOptions) {}

  public dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!isRequest(message)) return undefined;
    switch (message.type) {
      case "fleet_browser.windows.list.request":
        return this.handleList(message);
      case "fleet_browser.window.show.request":
        return this.handleShow(message);
      case "fleet_browser.window.thumbnail.request":
        return this.handleThumbnail(message);
      case "fleet_browser.window.control.request":
        return this.handleControl(message);
      case "fleet_browser.window.close.request":
        return this.handleClose(message);
    }
  }

  private async attempt<T>(
    work: (service: FleetBrowserService) => Promise<T>,
  ): Promise<{ value: T | null; error: string | null }> {
    const service = this.options.service;
    if (!service) return { value: null, error: "The fleet browser is unavailable on this host" };
    try {
      return { value: await work(service), error: null };
    } catch (error) {
      if (!(error instanceof FleetBrowserError)) {
        this.options.logger.warn({ err: error }, "fleet_browser.request_failed");
      }
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleList(request: RequestOf<"fleet_browser.windows.list.request">) {
    const result = await this.attempt((service) => service.listForWorkspace(request.workspaceId));
    this.options.emit({
      type: "fleet_browser.windows.list.response",
      payload: { requestId: request.requestId, error: result.error, windows: result.value ?? [] },
    });
  }

  private async handleShow(request: RequestOf<"fleet_browser.window.show.request">) {
    const result = await this.attempt((service) => service.show(request.windowId));
    this.options.emit({
      type: "fleet_browser.window.show.response",
      payload: { requestId: request.requestId, error: result.error, shown: result.value === true },
    });
  }

  private async handleThumbnail(request: RequestOf<"fleet_browser.window.thumbnail.request">) {
    const result = await this.attempt((service) =>
      service.thumbnail(request.windowId, request.maxWidth),
    );
    this.options.emit({
      type: "fleet_browser.window.thumbnail.response",
      payload: { requestId: request.requestId, error: result.error, thumbnail: result.value },
    });
  }

  private async handleControl(request: RequestOf<"fleet_browser.window.control.request">) {
    const result = await this.attempt((service) =>
      service.control(request.windowId, request.action, request.note ?? null),
    );
    this.options.emit({
      type: "fleet_browser.window.control.response",
      payload: {
        requestId: request.requestId,
        error: result.error,
        window: result.value?.window ?? null,
        delivery: result.value?.delivery ?? "none",
      },
    });
  }

  private async handleClose(request: RequestOf<"fleet_browser.window.close.request">) {
    const result = await this.attempt((service) => service.close(request.windowId));
    this.options.emit({
      type: "fleet_browser.window.close.response",
      payload: { requestId: request.requestId, error: result.error, closed: result.value === true },
    });
  }
}
