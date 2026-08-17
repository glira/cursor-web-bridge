export type StreamHandlers = {
  onText: (chunk: string) => void;
  onStatus: (message: string) => void;
  /** Agent execution UI lines (Exploring…, tools, Planning…). */
  onActivity?: (lines: string[]) => void;
  /** Replace the entire streaming assistant message (new bubble replaced ack). */
  onReplace?: (fullText: string) => void;
};
