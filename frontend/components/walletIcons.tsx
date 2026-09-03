/// Original, minimal glyphs for wallets we can't source a live icon for (see WalletModal's
/// comment on why: an EIP-6963-detected extension reports its OWN icon on `connector.icon`, which
/// is what "Installed" always prefers — these are only the fallback for "Popular" entries nobody
/// has installed yet, where there is no live provider to ask). Each is original artwork sized to
/// the wallet's real brand color, not a traced copy of the trademarked logo.
import type { ReactElement, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function MetaMaskIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#F6851B" />
      <path d="M29 11 21.5 16.6l1.4-3.3z" fill="#fff" stroke="#fff" strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M11 11l7.4 5.7-1.3-3.4z" fill="#fff" stroke="#fff" strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M25.6 24.4 23.7 27.7l4.1 1.1 1.2-4.3zM11 24.5l1.2 4.3 4.1-1.1-1.9-3.2z" fill="#fff" stroke="#fff" strokeWidth="0.5" strokeLinejoin="round" />
      <path d="M16.1 19.3l-1.1 1.7 4 .2-.1-4.3zM23.9 19.3l-2.9-2.5-.1 4.4 4-.2zM16.3 27.7l2.5-1.2-2.1-1.6zM21.2 26.5l2.5 1.2-.4-2.8z" fill="#fff" stroke="#fff" strokeWidth="0.4" strokeLinejoin="round" />
    </svg>
  );
}

export function PhantomIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#AB9FF2" />
      <path
        d="M31 21.3c0 5.9-4.9 10.7-11 10.7S9 27.2 9 21.3C9 14.5 13.9 9 20 9s11 5.5 11 12.3z"
        fill="#fff"
      />
      <path
        d="M15.6 23.1c0 2.1-1.2 3.1-2.5 3.1-1.4 0-2.5-1-2.5-2.4 0-2.4 2-6.4 4.3-6.4.9 0 1.4.7 1.4 1.6 0 1-1.2 3-1.2 4.1z"
        fill="#AB9FF2"
      />
      <circle cx="17.6" cy="20.5" r="1.6" fill="#AB9FF2" />
      <circle cx="23.2" cy="20.5" r="1.6" fill="#AB9FF2" />
    </svg>
  );
}

export function BackpackIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#EB4238" />
      <rect x="13" y="15" width="14" height="15" rx="3.5" fill="#fff" />
      <path d="M16 15v-2a4 4 0 018 0v2" stroke="#EB4238" strokeWidth="2" strokeLinecap="round" />
      <rect x="16.5" y="19.5" width="7" height="5" rx="1.3" fill="#EB4238" />
      <circle cx="20" cy="22" r="0.9" fill="#fff" />
    </svg>
  );
}

export function RainbowIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#001E59" />
      <circle cx="9" cy="31" r="2.4" fill="#FFD23F" />
      <path d="M9 24a15 15 0 0115 15h-4A11 11 0 009 24z" fill="#FF4000" />
      <path d="M9 19a20 20 0 0120 20h-4A16 16 0 009 19z" fill="#FF7F00" />
      <path d="M9 14a25 25 0 0125 25h-4A21 21 0 009 14z" fill="#0AB0E9" />
      <path d="M9 9a30 30 0 0130 30h-4A26 26 0 009 9z" fill="#7CE0FF" />
    </svg>
  );
}

export function BaseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#0052FF" />
      <path d="M20 30a10 10 0 100-20 10 10 0 000 20zM12 20h16" stroke="#0052FF" strokeWidth="0" />
      <circle cx="20" cy="20" r="9" fill="#fff" />
      <path d="M20 11a9 9 0 000 18v-3.6a5.4 5.4 0 010-10.8V11z" fill="#0052FF" />
    </svg>
  );
}

export function WalletConnectIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#3B99FC" />
      <path
        d="M13.5 17.2c3.6-3.5 9.4-3.5 13 0l.5.4a.5.5 0 010 .7l-1.5 1.5a.3.3 0 01-.4 0l-.6-.6c-2.5-2.4-6.5-2.4-9 0l-.7.7a.3.3 0 01-.4 0l-1.5-1.5a.5.5 0 010-.7z"
        fill="#fff"
      />
      <path
        d="M28.9 20.4l1.4 1.3a.5.5 0 010 .7l-6.1 6a.4.4 0 01-.5 0l-4.3-4.3-.2-.1-4.3 4.3a.4.4 0 01-.5 0l-6.1-6a.5.5 0 010-.7l1.4-1.3a.4.4 0 01.5 0l4.3 4.2.2.1 4.3-4.2a.4.4 0 01.5 0l4.3 4.2.2.1 4.3-4.2a.4.4 0 01.5 0z"
        fill="#fff"
      />
    </svg>
  );
}

export function CoinbaseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#0052FF" />
      <circle cx="20" cy="20" r="10" fill="#fff" />
      <rect x="16" y="16" width="8" height="8" rx="2" fill="#0052FF" />
    </svg>
  );
}

export function TrustIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#3375BB" />
      <path d="M20 10l8 3v6c0 6-3.5 10.3-8 11.5C15.5 29.3 12 25 12 19v-6z" fill="#fff" />
      <path d="M20 10l8 3v6c0 6-3.5 10.3-8 11.5V10z" fill="#B9D4EE" />
    </svg>
  );
}

export function RabbyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#7B61FF" />
      <ellipse cx="20" cy="22" rx="8" ry="7" fill="#fff" />
      <path d="M13 16l3 4M27 16l-3 4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="17" cy="21" r="1.3" fill="#7B61FF" />
      <circle cx="23" cy="21" r="1.3" fill="#7B61FF" />
    </svg>
  );
}

export function OkxIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill="#000" />
      <rect x="17" y="10" width="6" height="6" fill="#fff" />
      <rect x="10" y="17" width="6" height="6" fill="#fff" />
      <rect x="24" y="17" width="6" height="6" fill="#fff" />
      <rect x="17" y="24" width="6" height="6" fill="#fff" />
    </svg>
  );
}

export function GenericWalletIcon({ letter, color, ...props }: IconProps & { letter: string; color: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" {...props}>
      <rect width="40" height="40" rx="10" fill={color} />
      <text x="20" y="26" textAnchor="middle" fontSize="16" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
        {letter}
      </text>
    </svg>
  );
}

export const WALLET_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  MetaMask: MetaMaskIcon,
  Phantom: PhantomIcon,
  Backpack: BackpackIcon,
  Rainbow: RainbowIcon,
  Base: BaseIcon,
  WalletConnect: WalletConnectIcon,
  "Coinbase Wallet": CoinbaseIcon,
  Trust: TrustIcon,
  Rabby: RabbyIcon,
  "OKX Wallet": OkxIcon,
};
