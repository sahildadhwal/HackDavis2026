import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PantryPal — AI Food Pantry Coordinator",
  description: "Photograph your fridge, get meal ideas, and let AI agents call food pantries to find what you need for free.",
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