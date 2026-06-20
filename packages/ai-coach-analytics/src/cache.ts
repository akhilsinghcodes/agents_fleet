/**
 * Minimal stand-in for the original cache.ts.
 * Only the SessionSource type is needed by parser-shared.ts in this package;
 * the disk-cache implementation (which depends on VS Code-specific parsers) is not ported.
 */
export interface SessionSource {
  kind: "vscode-session-file" | "cli-events";
  filePath: string;
  workspaceId: string;
  workspaceName: string;
  harness: string;
}
