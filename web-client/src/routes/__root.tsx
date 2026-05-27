/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '~/styles/app.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      {
        name: 'description',
        content: 'Browser client for joining Syncplay rooms with local media playback.'
      },
      { title: 'Syncplay Web' }
    ],
    links: [{ rel: 'stylesheet', href: appCss }]
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => <p className="not-found">Route not found.</p>,
  component: Outlet
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
