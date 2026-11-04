import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import "./markets.css";

export const metadata: Metadata = {
  title: "/markets · Your AI, connected to the market",
  description:
    "Chat with an AI analyst about your Dhan positions. Read-only: /markets can never trade.",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
