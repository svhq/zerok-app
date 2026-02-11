import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppHome from './app/page';

const APP_HOST_PREFIXES = ['devnet.', 'testnet.'];

export default function Home() {
  const host = headers().get('host') || '';
  const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const isAppHost = APP_HOST_PREFIXES.some(prefix => host.startsWith(prefix));

  if (!(isLocalhost || isAppHost)) {
    redirect('/landing');
  }

  return <AppHome />;
}
