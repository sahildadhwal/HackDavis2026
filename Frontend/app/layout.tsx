import type { Metadata } from "next";
import { Krona_One, Libertinus_Serif } from "next/font/google";
import "./globals.css";

const kronaOne = Krona_One({ weight: "400", subsets: ["latin"], variable: "--font-krona" });
const libertinusSerif = Libertinus_Serif({ weight: "400", subsets: ["latin"], variable: "--font-libertinus" });

export const metadata: Metadata = {
  title: "FridgeBridge",
  description: "AI-powered food pantry coordinator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${kronaOne.variable} ${libertinusSerif.variable} min-h-screen antialiased`}>{children}</body>
    </html>
  );
}
