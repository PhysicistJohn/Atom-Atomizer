import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../../desktop/src/renderer/styles.css';
import './web.css';

export const metadata: Metadata = {
  title: 'Atomizer — AtomOS',
  description: 'Browser-native RF analysis and SignalLab simulation from AtomOS.',
  manifest: '/manifest.json',
  applicationName: 'Atomizer',
  icons: {
    icon: [
      { url: '/icons/atomizer-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/atomizer-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Atomizer',
  },
};

export const viewport: Viewport = {
  // Real device width: phones get the responsive mobile layout (styles.css
  // max-width 880px layer) instead of a zoomed-out desktop canvas.
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07101d',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
