export interface WsEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

type EventHandler = (event: WsEvent) => void;

export class CompanionWebSocket {
  private ws: WebSocket | null = null;
  private url = "";
  private token = "";
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.ws?.close();
    this.ws = null;
    this.subscribedTerminals.clear();
  }

  on(eventType: string, handler: EventHandler) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType)!.add(handler);
    return () => { this.handlers.get(eventType)?.delete(handler); };
  }

  subscribeTerminal(id: string) {
    this.subscribedTerminals.add(id);
    this.send({ type: "subscribe", terminalId: id });
  }

  unsubscribeTerminal(id: string) {
    this.subscribedTerminals.delete(id);
    this.send({ type: "unsubscribe", terminalId: id });
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
      for (const id of this.subscribedTerminals) {
        this.send({ type: "subscribe", terminalId: id });
      }
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WsEvent;
        this.emit(data.type, data);
        this.emit("*", data);
      } catch { /* ignore malformed */ }
    };

    this.ws.onclose = () => {
      this.emit("disconnected", { type: "disconnected", payload: null, timestamp: new Date().toISOString() });
      this.scheduleReconnect();
    };
  }

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
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
