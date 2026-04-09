import { invoke } from "@tauri-apps/api/core";

export interface Credentials {
  server_url: string;
  username: string;
  password: string;
  session_token: string | null;
}

export interface HealthCheck {
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

export async function saveCredentials(
  serverUrl: string,
  username: string,
  password: string
): Promise<void> {
  return invoke("save_credentials", {
    serverUrl,
    username,
    password,
  });
}

export async function loadCredentials(): Promise<Credentials | null> {
  return invoke("load_credentials");
}

export async function clearCredentials(): Promise<void> {
  return invoke("clear_credentials");
}

export async function setSessionToken(token: string): Promise<void> {
  return invoke("set_session_token", { token });
}

export async function checkHealth(serverUrl: string): Promise<HealthCheck> {
  return invoke("check_health", { serverUrl });
}
