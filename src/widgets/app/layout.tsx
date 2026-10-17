'use client';

import { WidgetLayout } from '@nitrostack/widgets';
// Registers a window message listener as soon as the bundle runs, so a host that injects the tool
// result before React has hydrated (NitroStudio does) is not missed by WidgetLayout.
import '@nitrostack/widgets/runtime/widget-polyfill';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, fontFamily: 'system-ui, sans-serif' }}>
        <WidgetLayout>{children}</WidgetLayout>
      </body>
    </html>
  );
}
