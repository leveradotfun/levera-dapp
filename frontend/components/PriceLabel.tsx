"use client";

import { priceLabelParts } from "@/lib/launchpad";

export default function PriceLabel({ value, className }: { value: bigint; className?: string }) {
  const { before, zeros, after } = priceLabelParts(value);
  
  if (!zeros) {
    return <span className={className}>{before}</span>;
  }
  
  return (
    <span className={className}>
      {before}
      <sub className="text-[0.6em] align-sub">{zeros}</sub>
      {after}
    </span>
  );
}