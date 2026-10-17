'use client';

import { WidgetLayout } from '@nitrostack/widgets';

// Registers a window message listener as soon as the bundle runs in the browser, so a host that
// injects the tool result before React has hydrated (NitroStudio does) is not missed by
// WidgetLayout. Browser only: the polyfill touches `window` when it is imported, and Next also
// renders this layout on the server, where a plain import would crash the page with HTTP 500.
if (typeof window !== 'undefined') {
  void import('@nitrostack/widgets/runtime/widget-polyfill');
}

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
