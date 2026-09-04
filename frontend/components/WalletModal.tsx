"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useConnect, useAccount } from "wagmi";
import type { Connector } from "wagmi";
import { toastError } from "@/lib/toast";
import { WALLET_ICONS, GenericWalletIcon } from "./walletIcons";

interface WalletModalProps {
  open: boolean;
  onClose: () => void;
}

const WALLET_INFO: Record<string, { letter: string; color: string }> = {
  WalletConnect: { letter: "W", color: "#3B99FC" },
  MetaMask: { letter: "M", color: "#F6851B" },
  "Coinbase Wallet": { letter: "C", color: "#0052FF" },
  Phantom: { letter: "P", color: "#AB9FF2" },
  Trust: { letter: "T", color: "#E31937" },
  Rabby: { letter: "R", color: "#7B61FF" },
  "OKX Wallet": { letter: "O", color: "#000000" },
  Backpack: { letter: "B", color: "#F7931A" },
};

/// Wallets to always offer even when not currently detected in the browser, matched against live
/// connectors by name (case-insensitive) so an installed one is never shown twice. `installUrl` is
/// where a click goes for one that ISN'T installed; WalletConnect has none because it isn't a
/// browser extension -- clicking it always tries to connect directly.
const POPULAR_WALLETS: { name: string; installUrl: string | null }[] = [
  { name: "Rainbow", installUrl: "https://rainbow.me/download" },
  { name: "Base", installUrl: "https://www.base.org/wallet" },
  { name: "MetaMask", installUrl: "https://metamask.io/download" },
  { name: "WalletConnect", installUrl: null },
  { name: "Coinbase Wallet", installUrl: "https://www.coinbase.com/wallet/downloads" },
];

const LAST_WALLET_KEY = "levera:last-wallet-id";
const TOS_ACCEPTED_KEY = "levera:tos-accepted";

/// wagmi's generic "injected" connector always targets whatever `window.ethereum` currently
/// points at, and only shows up NAMED (via EIP-6963) when the extension announces itself that
/// way -- not every wallet does, or the announcement can lag the page's first render. When that
/// happens the generic connector is still real and still works, it just has no name to show. Most
/// wallets mark their own provider with an `isXxx` flag (the de facto standard MetaMask started
/// and everyone else followed for exactly this kind of detection) -- read those directly rather
/// than showing an unhelpful "Injected" tile a user has no way to identify.
function detectInjectedWalletName(): string | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
  if (!eth) return null;
  const flags: [string, string][] = [
    ["isPhantom", "Phantom"],
    ["isBackpack", "Backpack"],
    ["isRabby", "Rabby"],
    ["isTrust", "Trust"],
    ["isOkxWallet", "OKX Wallet"],
    ["isCoinbaseWallet", "Coinbase Wallet"],
    ["isMetaMask", "MetaMask"], // checked last: several wallets (Rabby, others) also set this
  ];
  // window.ethereum.providers is the older, pre-EIP-6963 convention for "more than one extension
  // is here" -- if present, prefer whichever entry identifies itself, since `window.ethereum`
  // itself may just be a proxy over all of them.
  const list = Array.isArray(eth.providers) ? (eth.providers as Record<string, unknown>[]) : [eth];
  for (const [flag, name] of flags) {
    if (list.some((p) => p?.[flag])) return name;
  }
  return null;
}

const TOS_TEXT = `Terms of Service
Last updated August 20, 2026

These Terms of Service are an agreement between you and the operators of Levera ("Levera," "we," "us"). They apply to everything you do on this site: browsing, connecting a wallet, launching a token, trading, or claiming anything. If you do not agree with them, do not use the platform.

We've written these in plain language on purpose. The headings are part of the terms, not decoration.

1. What Levera is
Levera is a website for launching and trading tokens on Ethereum-compatible chains. Most of what happens on Levera happens on the blockchain, executed and signed by your own wallet. Some of it — launching, dev-buys, and the rewards mechanics described in sections 4 through 6 — involves wallets we operate. These terms tell you exactly which is which, because the difference matters.

2. We are not your adviser
Nothing on this site — listings, charts, prices, market caps, reward figures, or anything we or other users write — is investment, financial, legal, or tax advice, or a recommendation to buy, sell, or hold anything. We are not your broker, adviser, or fiduciary, and using the site does not make us one. Decisions are yours; make them with your own advisers.

3. Trading is self-custodial
When you buy or sell a token on Levera, the transaction is built in your browser, signed by your wallet, and submitted to the network. We never hold your private keys. Confirmed transactions are irreversible — by anyone, including us. We cannot recover funds you send to a wrong address, sign into a phishing site, or lose to a compromised wallet or extension. Check every transaction before you approve it; the security of your keys and seed phrase is entirely on you.

4. Where our wallets are involved
Three flows pass through wallets we operate. We're telling you this precisely because most launch platforms don't:

Launching. The launch fee and any dev-buy amount you choose are paid to an operator wallet we control. Your launch then executes as a single atomic bundle: the token is minted, the pool is created and seeded, and your dev-buy fills as the pool's first trade — all in one bundle that either fully lands on chain or does not happen at all. If the bundle never lands, nothing was created and we return what you paid.

Dev-buy delivery. The tokens your dev-buy purchased are delivered to your wallet in a follow-up transaction after the bundle lands. If that delivery is interrupted — network congestion, an error on our side — your tokens sit in the operator wallet until delivery completes, and the site will show your launch as finalizing. A launch showing an error after the bundle landed does not mean nothing happened; it means delivery is pending. We complete stranded deliveries; we do not keep them.

Transfer-tax collection. For tokens with a transfer tax (section 6), collected tax accrues in a rewards wallet we operate until it is distributed.

None of this makes us a bank, exchange, or deposit-taker. We do not hold account balances for you, there is nothing to "withdraw," and outside the specific flows above, your assets never touch our wallets.

5. Fees
You'll always see the exact cost before you sign. Currently:

Launch fee — a flat fee, shown in the launch flow before you pay.
Pool trading fees — every pool has a fee tier fixed at launch. On pools with creator revenue sharing, the split between the creator's share and ours is shown at launch. Fee tiers are set on chain at pool creation and cannot be changed afterward — by the creator or by us.
Transfer tax — where the creator enables it, at the rate they choose (section 6), shown on the token's page.
We can change fees for future launches at any time. We cannot and will not change the on-chain fee configuration of an existing pool.

6. Transfer tax and holder rewards
Some tokens launched on Levera carry a transfer tax — a transfer fee set by the creator at launch, at a rate shown on the token's page. The tax is a property of the token itself and applies to transfers wherever they happen.

Collected tax accrues in a rewards wallet we operate. We periodically convert and distribute accrued amounts to token holders. Read the following carefully, because it defines what this is and is not:

Distributions are a mechanical feature of how these tokens work, not an investment product, dividend, revenue share, or yield. Holding a token gives you no contractual right to any distribution, any amount, or any schedule.
Figures on the site describing past distributions are historical. They are not a promise, projection, or basis for expecting anything in the future.
Distributions can be delayed or halted at any time — including by automated safety checks that stop payouts when accounting cannot be verified — and the program itself can be changed or discontinued prospectively.
Certain wallets are excluded from distributions, including wallets we operate.
If you are buying a token because you expect to profit from our efforts in operating this mechanism, do not buy it.

7. Buybacks and our own trading
Wallets we operate transact on the platform in the ordinary course: converting accrued fee revenue between assets, executing distributions, and managing treasury. We may hold tokens launched on the platform, including our own.

Any buyback or burn programs described on this site are historical only. They are not a commitment to future purchases, may be started, stopped, or changed at any time without notice, and may have the effect of supporting the token's market price above where it would otherwise be. Tokens do not represent a right to revenue, buybacks, or any distribution. Do not rely on past purchases as an indication of future ones.

8. Stock-paired tokens are not stock — or any other instrument
"Stock-paired" means a token trades against a tokenized-equity quote asset. It describes the trading market and nothing else. A token paired against a tokenized stock is not stock, and it is not a derivative of stock: it is not collateralized by, redeemable for, or a claim on any share or company; it is not designed to track, and does not promise to track, any stock's price; and it confers no ownership, dividend, voting, or other right against anyone. The only relationship between a token and its quote asset is that they sit in the same liquidity pool.

We do not issue, custody, redeem, or guarantee any quote asset, and we are not affiliated with any exchange, public company, broker-dealer, or tokenized-equity issuer. A token's name, ticker, or image is chosen by its creator and means nothing about what the token legally is. The quote assets themselves carry issuer, custody, redemption, and de-pegging risks that are entirely outside our control.

9. Listings, and what we can do about them
Anyone can launch a token here. We do not vet, audit, or endorse tokens, creators, or their claims, and a listing on Levera is not evidence that a project is genuine or safe. Scams, impersonation, and rug pulls are known risks of permissionless launch platforms. Verify independently before you transact.

That said, we do run automated checks at launch, we control which quote assets are eligible, and we reserve the right to hide or remove any listing from the site, restrict any token's access to platform features (including reward distributions), or refuse any launch — at our discretion, particularly for suspected fraud, impersonation, market manipulation, or legal risk. Hiding a listing does not remove anything from the blockchain; pools exist on chain regardless of whether we display them.

10. Your content
When you launch a token you supply its name, ticker, image, description, and links. You grant us a worldwide, royalty-free license to display, reproduce, and distribute that content in operating and promoting the platform. You promise you have the rights to everything you submit, and that it does not impersonate any person or organization or infringe anyone's trademark, copyright, or other rights.

To report content that infringes your rights or impersonates you, contact us through the platform's official channels. We may remove reported content and terminate access for repeat infringers.

11. What you can't do
Do not use Levera to break the law. Do not manipulate markets — including wash trading, coordinated bundling to corner a token's supply, or launching tokens designed to deceive buyers. Do not attack, probe, or attempt to exploit the platform or its integrations. Do not use the platform to evade sanctions or launder money. We can restrict or terminate access for any of this, and these terms do not obligate us to warn you first.

12. Eligibility
You can use Levera only if you are of legal age where you live and only where doing so is lawful. You may not use the platform if you are located in, incorporated in, or a resident of any jurisdiction subject to comprehensive sanctions, or if you appear on any sanctions or restricted-party list. We may restrict access from any jurisdiction at any time, with or without notice.

Whether a token, quote asset, or trade is lawful for you — including whether it is treated as a security or derivative under your local law — depends on where you are, and you are responsible for knowing. If tokenized-equity products are not available to people in your jurisdiction, do not trade against them here.

13. Token risks
Tokens launched here — especially new ones — can be extremely volatile and illiquid. Prices can go to zero fast, with no warning and no recovery. Early-stage liquidity means even small trades can move prices violently. Only risk what you can afford to lose entirely.

The platform also depends on infrastructure we don't control: Ethereum, RPC and data providers. Any of it can have bugs, exploits, outages, or errors, and so can we. Displayed prices, charts, and stats can be delayed or wrong; do not trade on them as if they were guaranteed accurate.

14. Disclaimers and limits on our liability
The platform and everything on it are provided "as is" and "as available," without warranties of any kind — express, implied, or statutory — including merchantability, fitness for a particular purpose, and accuracy.

To the fullest extent the law allows, we accept no liability to you at all arising from the platform or any token launched or traded on it — including direct losses, lost funds, lost profits, lost data, and indirect, incidental, special, consequential, or punitive damages — however caused, even if we were advised of the possibility.

Some jurisdictions do not allow some of these exclusions, so parts of this section may not apply to you. Nothing in these terms excludes liability that cannot legally be excluded — including for fraud or willful misconduct — or limits any consumer right you have that the law says cannot be waived.

15. Indemnity
If we get sued or fined because of your token, your content, your trading, or your breach of these terms or the law, you will defend us and cover the losses and reasonable legal fees. "Us" here includes our entity, operators, employees, and contributors.

16. Changes to these terms
When we change these terms we will update the date at the top, and for material changes we will post a notice on the site. Changes apply from when they are posted, not retroactively. If you keep using the platform after a change takes effect, the new terms apply to you; if you do not agree with a change, stop using the platform.

17. The rest
If part of these terms is found unenforceable, the rest stands. Our not enforcing a term is not a waiver of it. You cannot assign these terms; we can, to a successor of the platform. Sections that by their nature should survive (4 through 8, 14, and 15) survive termination. These terms are the whole agreement between us about the platform.`;

type Phase = "tos" | "confirmed" | "wallets";

function WalletIcon({ name, connectorIcon, size = 40 }: { name: string; connectorIcon?: string; size?: number }) {
  // An EIP-6963-detected extension self-reports its own icon on the connector -- prefer that,
  // since it's the wallet's own real logo with zero licensing ambiguity, over any static asset
  // this app ships. Only fall back to our own glyph set (or a generic initial) when there is no
  // live provider to ask, which is exactly the "Popular but not installed" case.
  if (connectorIcon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={connectorIcon} alt="" width={size} height={size} className="rounded-xl shrink-0" style={{ width: size, height: size }} />;
  }
  const Icon = WALLET_ICONS[name];
  if (Icon) return <Icon width={size} height={size} className="rounded-xl shrink-0" />;
  const info = WALLET_INFO[name];
  return (
    <GenericWalletIcon
      letter={info?.letter ?? name[0]?.toUpperCase() ?? "?"}
      color={info?.color ?? "#666"}
      width={size}
      height={size}
      className="rounded-xl shrink-0"
    />
  );
}

export default function WalletModal({ open, onClose }: WalletModalProps) {
  const { connectors, connect, isPending } = useConnect();
  const { isConnected } = useAccount();
  const [phase, setPhase] = useState<Phase>("tos");
  const [search, setSearch] = useState("");
  const [pendingConnector, setPendingConnector] = useState<string | null>(null);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [lastWalletId, setLastWalletId] = useState<string | null>(null);
  const [injectedBrandName, setInjectedBrandName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Re-check every time the modal opens: an extension can finish injecting after first paint.
    setInjectedBrandName(detectInjectedWalletName());
  }, [open]);

  /// The name to show for a connector: its own EIP-6963 name when it has one, or a brand-flag
  /// detection for the generic "injected" fallback, or "Injected" as the last resort.
  const displayNameFor = useCallback(
    (c: Connector) => (c.id === "injected" ? injectedBrandName ?? c.name : c.name),
    [injectedBrandName]
  );

  useEffect(() => {
    if (isConnected) {
      onClose();
      setPendingConnector(null);
    }
  }, [isConnected, onClose]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setScrolledToBottom(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    try {
      setLastWalletId(localStorage.getItem(LAST_WALLET_KEY));
      // The Terms only need accepting once per browser, not on every single connect attempt --
      // re-showing a wall of legal text every time someone reconnects is friction with no benefit.
      const accepted = localStorage.getItem(TOS_ACCEPTED_KEY) === "1";
      setPhase(accepted ? "wallets" : "tos");
    } catch {
      // localStorage unavailable (private mode, etc.) -- fall back to asking every time.
      setPhase("tos");
    }
  }, [open]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setScrolledToBottom(atBottom);
  }, []);

  const handleConfirmTos = useCallback(() => {
    try {
      localStorage.setItem(TOS_ACCEPTED_KEY, "1");
    } catch {
      /* best effort */
    }
    setPhase("confirmed");
  }, []);

  const handleConnect = useCallback((connector: Connector) => {
    setPendingConnector(connector.name);
    connect(
      { connector },
      {
        onSuccess: () => {
          try {
            localStorage.setItem(LAST_WALLET_KEY, connector.id);
          } catch {
            /* best effort */
          }
        },
        onError: (err) => {
          setPendingConnector(null);
          toastError(err, "Couldn't connect.");
        },
      }
    );
  }, [connect]);

  // Split live connectors into "installed" (a real, currently-detected provider -- injected
  // extensions via EIP-6963) vs the WalletConnect connector, which is never "installed" since it
  // isn't a browser extension at all.
  //
  // wagmi's injected() always registers a generic "Injected" pseudo-connector for window.ethereum
  // ALONGSIDE whatever EIP-6963-announced wallets it finds -- so a browser with MetaMask installed
  // shows both "MetaMask" (real name, real icon) and a second "Injected" entry pointing at the
  // exact same provider. Drop the generic one whenever a named alternative exists; keep it only as
  // a last resort when it's the sole provider detected (an old wallet that predates EIP-6963).
  const installedConnectors = useMemo(() => {
    const real = connectors.filter((c) => c.type !== "walletConnect" && c.id !== "injected");
    if (real.length > 0) return real;
    return connectors.filter((c) => c.type !== "walletConnect");
  }, [connectors]);
  const walletConnectConnector = useMemo(
    () => connectors.find((c) => c.type === "walletConnect"),
    [connectors]
  );

  const installedNames = useMemo(
    () => new Set(installedConnectors.map((c) => displayNameFor(c).toLowerCase())),
    [installedConnectors, displayNameFor]
  );

  // Popular entries not already covered by a live (installed) connector, so nothing is shown twice.
  const popularNotInstalled = useMemo(
    () => POPULAR_WALLETS.filter((w) => w.name !== "WalletConnect" && !installedNames.has(w.name.toLowerCase())),
    [installedNames]
  );
  const showWalletConnectInPopular = !installedNames.has("walletconnect");

  const matchesSearch = useCallback(
    (name: string) => !search || name.toLowerCase().includes(search.toLowerCase()),
    [search]
  );

  const filteredInstalled = installedConnectors.filter((c) => matchesSearch(displayNameFor(c)));
  const filteredPopular = popularNotInstalled.filter((w) => matchesSearch(w.name));
  const showWc = showWalletConnectInPopular && matchesSearch("WalletConnect");

  const sortByLastUsed = useCallback(
    <T extends { id?: string; name: string }>(items: T[]): T[] => {
      if (!lastWalletId) return items;
      return [...items].sort((a, b) => {
        const aLast = a.id === lastWalletId ? 1 : 0;
        const bLast = b.id === lastWalletId ? 1 : 0;
        return bLast - aLast;
      });
    },
    [lastWalletId]
  );

  if (!open) return null;

  return (
    // On phones this is a bottom sheet (anchored to the bottom edge, sliding up), on desktop a
    // centered dialog -- same content, only the placement and entrance animation differ.
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm animate-fade-in sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-5 shadow-2xl animate-sheet-up sm:max-w-sm sm:animate-none sm:rounded-2xl"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sheet grab handle -- purely visual, shown where the panel slides up from the bottom edge. */}
        <div className="mx-auto mb-3 h-1 w-10 shrink-0 rounded-full bg-border sm:hidden" />
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-foreground">
            {phase === "wallets" ? "Connect a wallet" : "Terms of Service"}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-surface hover:bg-hover flex items-center justify-center text-muted hover:text-foreground transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase === "tos" && (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 min-h-0 overflow-y-auto rounded-xl bg-surface/50 border border-border p-4 mb-3 text-[11px] leading-relaxed text-secondary whitespace-pre-wrap max-h-72"
            >
              {TOS_TEXT}
            </div>
            {!scrolledToBottom && (
              <p className="text-center text-[11px] text-muted mb-2">Scroll to the bottom to continue</p>
            )}
            <button
              type="button"
              onClick={handleConfirmTos}
              disabled={!scrolledToBottom}
              className="w-full rounded-xl py-3 text-sm font-semibold transition-colors bg-accent text-accent-ink disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:opacity-90"
            >
              Confirm
            </button>
          </>
        )}

        {phase === "confirmed" && (
          <div className="flex flex-col items-center justify-center py-10 gap-4 text-center">
            <div className="w-14 h-14 rounded-full bg-accent/15 flex items-center justify-center">
              <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Terms confirmed</p>
              <p className="text-xs text-muted mt-1 max-w-[240px]">
                You can now choose a wallet to connect to Levera.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPhase("wallets")}
              className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
            >
              Proceed
            </button>
          </div>
        )}

        {phase === "wallets" && (
          <>
            <div className="relative mb-3">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-surface border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-4 max-h-80 overflow-y-auto">
              {filteredInstalled.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-accent uppercase tracking-wider mb-1.5 px-1">Installed</div>
                  <div className="flex flex-col gap-1">
                    {sortByLastUsed(filteredInstalled).map((c) => {
                      const isConnecting = isPending && pendingConnector === c.name;
                      const isLast = c.id === lastWalletId;
                      const name = displayNameFor(c);
                      return (
                        <button
                          key={c.uid}
                          onClick={() => handleConnect(c)}
                          disabled={isPending}
                          className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface transition-colors text-left group disabled:opacity-60"
                        >
                          <WalletIcon name={name} connectorIcon={c.icon} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
                              {name}
                              {isLast && (
                                <span className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent text-[9px] font-semibold uppercase tracking-wider">
                                  Last used
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted">Detected in your browser</div>
                          </div>
                          {isConnecting ? (
                            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                          ) : (
                            <span className="px-2 py-0.5 rounded-md bg-accent/15 text-accent text-[10px] font-semibold uppercase tracking-wider shrink-0">
                              Connect
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {(filteredPopular.length > 0 || showWc) && (
                <div>
                  <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1.5 px-1">Popular</div>
                  <div className="flex flex-col gap-1">
                    {showWc && (
                      <button
                        onClick={() => {
                          if (walletConnectConnector) handleConnect(walletConnectConnector);
                        }}
                        disabled={isPending || !walletConnectConnector}
                        title={walletConnectConnector ? undefined : "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable"}
                        className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface transition-colors text-left group disabled:opacity-40"
                      >
                        <WalletIcon name="WalletConnect" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground">WalletConnect</div>
                          <div className="text-xs text-muted">
                            {walletConnectConnector ? "Scan with any mobile wallet" : "Not configured"}
                          </div>
                        </div>
                        {isPending && pendingConnector === "WalletConnect" ? (
                          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                        ) : (
                          <span className="px-2 py-0.5 rounded-md bg-surface text-muted text-[10px] font-semibold uppercase tracking-wider shrink-0 group-hover:bg-accent/15 group-hover:text-accent transition-colors">
                            {walletConnectConnector ? "Connect" : "Setup"}
                          </span>
                        )}
                      </button>
                    )}

                    {filteredPopular.map((w) => (
                      <a
                        key={w.name}
                        href={w.installUrl ?? "#"}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface transition-colors text-left group"
                      >
                        <WalletIcon name={w.name} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground">{w.name}</div>
                          <div className="text-xs text-muted">Not installed</div>
                        </div>
                        <span className="px-2 py-0.5 rounded-md bg-surface text-muted text-[10px] font-semibold uppercase tracking-wider shrink-0 group-hover:bg-accent/15 group-hover:text-accent transition-colors">
                          Install
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {filteredInstalled.length === 0 && filteredPopular.length === 0 && !showWc && (
                <div className="text-center py-6 text-muted text-sm">No wallets found</div>
              )}
            </div>
          </>
        )}

        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-xs text-muted">
          <span>What&apos;s a wallet?</span>
          {phase === "wallets" && (
            <button
              type="button"
              onClick={() => setPhase("tos")}
              className="hover:text-foreground transition-colors"
            >
              Terms of Service
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
