import "./globals.css";

export const metadata = {
  title: "G SPORT ANALYSIS | Football Intelligence",
  description:
    "Free football analytics, match previews and data-driven predictions across competitions worldwide.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
