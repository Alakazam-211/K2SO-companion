import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "K2SO Companion — UI Mockup",
  description: "Interactive mockup of the K2SO Companion mobile app",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-neutral-950 text-white flex items-center justify-center">
        {children}
      </body>
    </html>
  );
}
