import type { Metadata } from "next";
import { ThemeProvider } from "@/features/theme/theme-provider";
import "./globals.css";
import "./styles/tokens.css";
import "./styles/foundation.css";
import "./styles/controls.css";
import "./styles/workspace.css";

export const metadata: Metadata = {
  title: "melon",
  description: "Private pattern library",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
