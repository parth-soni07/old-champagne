import type { Metadata, Viewport } from "next";
import { Nunito, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Display: Nunito's rounded terminals echo the clay shapes. Body: Plus Jakarta Sans for legibility
// at small sizes. Both variable, self-hosted by next/font (no runtime request to Google).
const display = Nunito({ variable: "--font-display", subsets: ["latin"] });
const body = Plus_Jakarta_Sans({ variable: "--font-body", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "wind day-ahead",
  description: "how far to trust the uk national wind forecast when buying power day-ahead.",
};

export const viewport: Viewport = { themeColor: "#e8f1fb", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
