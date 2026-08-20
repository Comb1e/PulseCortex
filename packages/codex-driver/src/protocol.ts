export const SUPPORTED_CODEX_CLI_SERIES = "0.148";
export const SUPPORTED_PROTOCOL_MAJOR = 2;
export const MAX_JSONL_LINE_BYTES = 10 * 1024 * 1024;

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

export function isRequest(value: unknown): value is JsonRpcRequest {
  return !!value && typeof value === "object" && "method" in value && "id" in value && typeof (value as JsonRpcRequest).method === "string";
}

export function isNotification(value: unknown): value is JsonRpcNotification {
  return !!value && typeof value === "object" && "method" in value && !("id" in value) && typeof (value as JsonRpcNotification).method === "string";
}

export function isResponse(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
  return !!value && typeof value === "object" && "id" in value && !("method" in value) && ("result" in value || "error" in value);
}
