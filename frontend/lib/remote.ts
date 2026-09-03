/// Thin fetch helpers for the Postgres-backed store. Fail soft: a down database
/// must not take trading or the page with it.

export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function apiPost(path: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function apiDelete(path: string, body?: unknown): Promise<boolean> {
  try {
    const r = await fetch(path, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}
