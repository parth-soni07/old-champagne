import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// SF Pro on Apple devices via the system stack; Inter is the closest fallback elsewhere.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Wind Day-Ahead",
  description: "How far to trust the UK national wind forecast when buying power day-ahead.",
};

export const viewport: Viewport = { themeColor: "#eef0f5", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
