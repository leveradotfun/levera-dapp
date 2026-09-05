/// Shared between the create page (signer) and the token-metadata API route (verifier).
/// No "use client" — the server route imports this too.

export type MetadataPayload = {
  imageUrl: string | null;
  website: string | null;
  telegram: string | null;
  discord: string | null;
  twitter: string | null;
  description: string | null;
};

/// Normalize a metadata field the way the API stores it: trimmed, empty -> null.
/// The client must normalize BEFORE signing so the signature covers exactly what is stored.
export function normMetadataField(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/// The canonical message a wallet signs to prove it owns a launch's metadata write. The API
/// rebuilds this from the STORED (normalized) fields and requires the signature to recover to
/// the launch's on-chain creator — without it, anyone could rewrite any coin's image or text.
/// MUST stay byte-identical between signer and verifier.
export function tokenMetadataMessage(launch: string, meta: MetadataPayload): string {
  return [
    "Levera token metadata",
    `launch: ${launch.toLowerCase()}`,
    `image: ${meta.imageUrl ?? ""}`,
    `description: ${meta.description ?? ""}`,
    `website: ${meta.website ?? ""}`,
    `telegram: ${meta.telegram ?? ""}`,
    `discord: ${meta.discord ?? ""}`,
    `twitter: ${meta.twitter ?? ""}`,
  ].join("\n");
}
