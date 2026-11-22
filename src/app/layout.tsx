import type { ReactNode } from "react";
import "@/app/globals.css";

export const metadata = {
  title: "study-note 어드민",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
