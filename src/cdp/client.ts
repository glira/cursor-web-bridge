type CdpResult = Record<string, unknown>;

type Pending = {
  resolve: (value: CdpResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connected = false;

  async connect(wsUrl: string): Promise<void> {
    if (this.ws) this.disconnect();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connected = true;
        resolve();
      });

      ws.addEventListener("error", () => {
        if (!this.connected) reject(new Error(`CDP WebSocket failed: ${wsUrl}`));
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener("close", () => {
        this.connected = false;
        this.rejectAll("WebSocket closed");
      });
    });
  }

  disconnect(): void {
    this.connected = false;
    this.rejectAll("Intentional disconnect");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<CdpResult> {
    if (!this.ws || !this.connected) throw new Error("CDP client not connected");

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string, timeoutMs = 15_000): Promise<T> {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );

    const exceptionDetails = result.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ?? exceptionDetails.text ?? "Evaluation failed",
      );
    }

    const remote = result.result as { value?: T } | undefined;
    return remote?.value as T;
  }

  async typeText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async pressKey(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; result?: CdpResult; error?: { message: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }

    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const pending = this.pending.get(msg.id)!;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result ?? {});
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
