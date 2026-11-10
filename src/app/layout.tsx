import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import { Suspense } from 'react';
import { Toasts } from '@/components/Toasts';
import './globals.css';

const plex = IBM_Plex_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-plex', display: 'swap' });

export const metadata: Metadata = {
  title: 'Health Camp Operations',
  description: 'Employee health camp operations platform',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#040A11' };

const themeInit = `try{if(localStorage.getItem('kriya-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={plex.variable} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInit }} /></head>
      <body>
        {children}
        <Suspense fallback={null}><Toasts /></Suspense>
      </body>
    </html>
  );
}
