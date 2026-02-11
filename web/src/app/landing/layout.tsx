import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ZeroK - Private SOL Transactions, Verified in Zero-Knowledge',
  description: 'Solana-native privacy for SOL. Self-custodial, verifiable, fast. Break the on-chain link between deposit and withdrawal using zero-knowledge proofs.',
  keywords: ['Solana', 'privacy', 'zero-knowledge', 'ZK proofs', 'cryptocurrency', 'DeFi'],
  openGraph: {
    title: 'ZeroK - Private SOL Transactions',
    description: 'Solana-native privacy for SOL. Self-custodial, verifiable, fast.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZeroK - Private SOL Transactions',
    description: 'Solana-native privacy for SOL. Self-custodial, verifiable, fast.',
  },
};

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zk-bg">
      {children}
    </div>
  );
}
