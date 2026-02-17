'use client';

const verificationPoints = [
  {
    title: 'Commitment Scheme',
    description: 'When you deposit, a cryptographic commitment (hash of secret + nullifier) is added to a Merkle tree. This commitment reveals nothing about your identity.',
    icon: 'hash',
  },
  {
    title: 'Nullifier System',
    description: 'Each withdrawal publishes a unique nullifier derived from your secret. The contract rejects duplicate nullifiers, preventing double-spends without revealing which deposit is yours.',
    icon: 'ban',
  },
  {
    title: 'On-Chain Proof Verification',
    description: 'The smart contract verifies your Groth16 proof directly on-chain. Invalid proofs are rejected. Valid proofs execute instantly.',
    icon: 'check',
  },
];

export default function Trust() {
  return (
    <section id="trust" className="landing-section bg-zk-surface/30">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <span className="tech-chip mb-4 inline-block">Trust Architecture</span>
          <h2 className="landing-h2 text-zk-text mb-4">
            Verify, don&apos;t trust
          </h2>
          <p className="text-zk-text-muted max-w-2xl mx-auto">
            ZeroK is designed so you never have to trust us. Every claim is cryptographically verifiable.
          </p>
        </div>

        {/* Verification Points */}
        <div className="space-y-6 mb-12">
          {verificationPoints.map((point, index) => (
            <div
              key={point.title}
              className="flex gap-4 p-6 rounded-xl bg-zk-surface/50 border border-zk-border hover:border-zk-teal/30 transition-colors"
            >
              {/* Number */}
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-zk-teal/10 flex items-center justify-center">
                <span className="text-zk-teal font-semibold">{index + 1}</span>
              </div>

              {/* Content */}
              <div>
                <h3 className="text-lg font-semibold text-zk-text mb-2 flex items-center gap-2">
                  {point.icon === 'hash' && (
                    <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                    </svg>
                  )}
                  {point.icon === 'ban' && (
                    <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                  )}
                  {point.icon === 'check' && (
                    <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  )}
                  {point.title}
                </h3>
                <p className="text-zk-text-muted text-sm leading-relaxed">{point.description}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Open Source Note */}
        <div className="text-center p-6 rounded-xl border border-zk-teal/20 bg-zk-teal/5">
          <div className="inline-flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <span className="text-zk-teal font-semibold">Open Source</span>
          </div>
          <p className="text-zk-text-muted text-sm">
            All smart contracts and circuits are open-source and publicly verifiable.{' '}
            <a
              href="https://github.com/svhq/zerok-app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zk-teal hover:underline"
            >
              Review the code on GitHub
            </a>.
          </p>
        </div>
      </div>
    </section>
  );
}
