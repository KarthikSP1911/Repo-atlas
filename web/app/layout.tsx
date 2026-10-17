import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RepoAtlas: a guided tour of any GitHub repo, then issues you can finish',
  description:
    'An MCP server that turns a GitHub repo into a graph of code, history, people and issues, so an AI agent can walk a newcomer through it and find first issues with the files to touch.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
