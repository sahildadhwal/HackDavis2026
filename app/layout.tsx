import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Food Pantry",
  description: "Find food pantries near you",
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
