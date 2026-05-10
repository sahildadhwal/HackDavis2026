import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PantryPal",
  description: "AI-powered food pantry coordinator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
