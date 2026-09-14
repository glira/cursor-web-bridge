export type DecisionKind = "approval" | "question";

export type DecisionOption = {
  id: string;
  label: string;
};

export type PendingDecision = {
  kind: DecisionKind;
  prompt: string;
  options: DecisionOption[];
};

export type StreamHandlers = {
  onText: (chunk: string) => void;
  onStatus: (message: string) => void;
  /** Agent execution UI lines (Exploring…, tools, Planning…). */
  onActivity?: (lines: string[]) => void;
  /** Replace the entire streaming assistant message (new bubble replaced ack). */
  onReplace?: (fullText: string) => void;
  /** Cursor Allow / Ask questions card in the IDE (CDP). null when it disappears. */
  onDecision?: (decision: PendingDecision | null) => void;
};
