export interface WsEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

type EventHandler = (event: WsEvent) => void;
type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let counter = 0;
function nextId(): string {
  return `msg-${++counter}-${Date.now()}`;
}

export class CompanionWebSocket {
  private ws: WebSocket | null = null;
  private url = "";
  private token = "";
  private handlers = new Map<string, Set<EventHandler>>();
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 3000;
  private shouldReconnect = false;
  private subscribedTerminals = new Set<string>();

  connect(serverUrl: string, sessionToken: string) {
    this.url = serverUrl.replace(/^http/, "ws");
    this.token = sessionToken;
    this.shouldReconnect = true;
    this.reconnectDelay = 3000;
    this.open();
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.subscribedTerminals.clear();
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Disconnected"));
      this.pending.delete(id);
    }
  }

  on(eventType: string, handler: EventHandler) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType)!.add(handler);
    return () => { this.handlers.get(eventType)?.delete(handler); };
  }

  /** Send a request and wait for the response. */
  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const id = nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timed out"));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  subscribeTerminal(id: string) {
    this.subscribedTerminals.add(id);
    this.request("terminal.subscribe", { terminalId: id }).catch(() => {});
  }

  unsubscribeTerminal(id: string) {
    this.subscribedTerminals.delete(id);
    this.request("terminal.unsubscribe", { terminalId: id }).catch(() => {});
  }

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private open() {
    this.ws?.close();
    this.ws = new WebSocket(`${this.url}/companion/ws?token=${encodeURIComponent(this.token)}`);

    this.ws.onopen = () => {
      this.reconnectDelay = 3000;
      this.emit("connected", { type: "connected", payload: null, timestamp: new Date().toISOString() });

      // Start heartbeat ping every 30 seconds
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        this.request("ping", {}).catch(() => {});
      }, 30000);

      // Re-subscribe to terminals
      for (const id of this.subscribedTerminals) {
        this.request("terminal.subscribe", { terminalId: id }).catch(() => {});
      }
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        // Response to a pending request (has id field)
        if (data.id && this.pending.has(data.id)) {
          const req = this.pending.get(data.id)!;
          this.pending.delete(data.id);
          clearTimeout(req.timer);

          if (data.error) {
            req.reject(new Error(data.error.message || "Server error"));
          } else {
            req.resolve(data.result);
          }
          return;
        }

        // Push event (has event field)
        if (data.event) {
          const event: WsEvent = {
            type: data.event,
            payload: data.data,
            timestamp: new Date().toISOString(),
          };
          this.emit(data.event, event);
          this.emit("*", event);
          return;
        }
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit("disconnected", { type: "disconnected", payload: null, timestamp: new Date().toISOString() });
      this.scheduleReconnect();
    };
  }

  private emit(type: string, event: WsEvent) {
    this.handlers.get(type)?.forEach((h) => h(event));
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
  }
}

export const ws = new CompanionWebSocket();
