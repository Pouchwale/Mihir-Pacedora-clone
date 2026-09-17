import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SessionWrapper from "@/components/providers/SessionWrapper";
import { ImpersonationBanner } from "@/components/layout/ImpersonationBanner";
import { Toaster } from "@/components/ui/Toaster";

export const metadata: Metadata = {
  title: "Gujarat Print Pack Mockup",
  description: "3D Packaging Mockup Generator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-background text-foreground flex flex-col">
        <SessionWrapper>
          <ImpersonationBanner />
          <Toaster />
          <div className="flex-1 flex flex-col">
            <main className="flex-1">{children}</main>
          </div>
        </SessionWrapper>
      </body>
    </html>
  );
}
