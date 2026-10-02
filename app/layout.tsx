import type { Metadata } from "next";

export const metadata: Metadata = {
title: "Gargantua — Prediction markets, composed",
description: "Explore live markets from Kalshi and Polymarket. Connect outcomes into one position, built for Solana.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ background: "#000", color: "#fff" }}>{children}</body>
    </html>
  );
}
