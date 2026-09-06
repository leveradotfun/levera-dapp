"use client";

import { useState } from "react";
import { withActiveSigner } from "@/lib/activeSigner";
import { normMetadataField, tokenMetadataMessage } from "@/lib/metadataSigning";
import type { TokenMetadata } from "@/lib/tokenMetadata";

/// Attach or revise a coin's image, description and links AFTER it has launched.
///
/// The create page could already write this, but only in the same breath as the launch itself --
/// and when that write failed (a dropped request, or the launch call throwing on a post-receipt
/// read), the coin was stranded imageless with no way back. The error even told people they could
/// "retry the launch details later", which was not true: nothing in the app could POST here again.
///
/// The API has always supported it. Writes are creator-signed and the row upserts, so the same
/// wallet can revise its own coin as often as it likes and nobody else can touch it. This is the
/// missing UI, not a new capability.
export default function EditTokenDetails({
  launchAddress,
  meta,
  onSaved,
  onClose,
}: {
  launchAddress: string;
  meta: TokenMetadata | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(meta?.imageUrl ?? null);
  const [description, setDescription] = useState(meta?.description ?? "");
  const [website, setWebsite] = useState(meta?.website ?? "");
  const [telegram, setTelegram] = useState(meta?.telegram ?? "");
  const [discord, setDiscord] = useState(meta?.discord ?? "");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/ipfs/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      setImageUrl(json.gatewayUrl || json.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Normalize BEFORE signing: the API rebuilds this message from the values it stores, so the
      // signature has to cover exactly those, not the raw inputs.
      const payload = {
        imageUrl: normMetadataField(imageUrl),
        description: normMetadataField(description),
        website: normMetadataField(website),
        telegram: normMetadataField(telegram),
        discord: normMetadataField(discord),
        twitter: null,
      };
      const signature = await withActiveSigner(async ({ signer }) =>
        signer.signMessage(tokenMetadataMessage(launchAddress, payload)),
      );
      const res = await fetch("/api/token-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launch: launchAddress, ...payload, signature }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save details");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">Edit coin details</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">
          Only this coin&apos;s creator can change these. You&apos;ll sign a message — no gas, no transaction.
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
            ) : (
              <div className="h-12 w-12 rounded-lg border border-border bg-surface" />
            )}
            <label className="cursor-pointer rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface">
              {uploading ? "Uploading…" : imageUrl ? "Change image" : "Upload image"}
              <input type="file" accept="image/*" className="hidden" onChange={onPickImage} disabled={uploading} />
            </label>
          </div>

          <textarea
            className={field}
            rows={3}
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input className={field} placeholder="Website" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <input className={field} placeholder="Telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
          <input className={field} placeholder="Discord" value={discord} onChange={(e) => setDiscord(e.target.value)} />

          {error ? <div className="text-xs text-red">{error}</div> : null}

          <button
            onClick={save}
            disabled={busy || uploading}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save details"}
          </button>
        </div>
      </div>
    </div>
  );
}
